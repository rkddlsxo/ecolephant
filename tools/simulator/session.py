"""Generate and optionally upload a reproducible, explicitly synthetic demonstration."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / "backend/.env")


def generate(seconds):
    samples = []
    for n in range(seconds):
        missing = n % 100 >= 90
        high = 15 <= n % 100 < 75
        camera, head = (38, 34) if high else (8, 6)
        samples.append({"seq":n + 1, "elapsed_start_ms":n * 1000, "duration_ms":1000,
                        "calibration_epoch":1, "active_mode":"none" if missing else "combined",
                        "quality":"no_sensor" if missing else "valid",
                        "camera_estimate_deg":None if missing else camera,
                        "head_flexion_deg":None if missing else head,
                        "display_angle_deg":None if missing else (camera + head) / 2,
                        "posture_level":"unknown" if missing else "high" if high else "normal",
                        "reason_code":"insufficient_data" if missing else "combined_high" if high else "within_range",
                        "confidence":"unavailable" if missing else "dual_sensor"})
    return samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=100)
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--base-url", default="http://127.0.0.1:5000")
    parser.add_argument("--output", type=Path, default=ROOT / ".data/simulation.json")
    args = parser.parse_args()
    if not 1 <= args.seconds <= 3600:
        parser.error("--seconds must be 1..3600")
    samples = generate(args.seconds)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"data_source":"demo", "samples":samples}, indent=2), encoding="utf-8")
    if not args.upload:
        print(f"Generated {len(samples)} synthetic windows: {args.output}")
        return
    token = os.getenv("ECOLEPHANT_LOCAL_TOKEN")
    if not token:
        parser.error("Run npm run setup first or set the local token environment variable")

    def post(path, data, key=None):
        headers = {"Content-Type":"application/json", "Authorization":"Bearer " + token}
        if key:
            headers["Idempotency-Key"] = key
        payload = json.dumps(data).encode()
        for attempt in range(4):
            try:
                with urlopen(Request(args.base_url.rstrip('/') + path, payload, headers), timeout=15) as response:
                    return json.load(response)
            except (HTTPError, URLError) as error:
                if isinstance(error, HTTPError) and error.code not in {429, 503}:
                    raise SystemExit(f"Upload rejected ({error.code}); no request content was printed") from None
                if attempt == 3:
                    raise SystemExit("Upload unavailable; generated windows remain in the output file") from None
                time.sleep(0.5 * 2 ** attempt)
    start = datetime.now(timezone.utc).replace(microsecond=0)
    session = post("/api/v1/sessions", {"client_session_id":str(uuid4()), "started_at":start.isoformat(),
                    "requested_mode":"combined", "policy_id":"draft-web-v0",
                    "initial_calibration_epoch":1, "data_source":"demo"}, str(uuid4()))
    path = "/api/v1/sessions/" + session["id"]
    for offset in range(0, len(samples), 60):
        post(path + "/samples:batch", {"samples":samples[offset:offset + 60]})
    post(path + "/complete", {"ended_at":(start + timedelta(seconds=args.seconds)).isoformat(),
                               "final_seq":len(samples), "final_event_seq":0})
    print("Completed synthetic session: " + session["id"])


if __name__ == "__main__":
    main()
