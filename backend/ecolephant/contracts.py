from datetime import datetime, timezone
from pathlib import Path
import json
import math
import re

from jsonschema import Draft202012Validator, FormatChecker
from .errors import ApiError

BASE = Path(__file__).parent / "contracts"
SPEC = json.loads((BASE / "openapi.json").read_text(encoding="utf-8"))
TIMESTAMP_PATTERN = re.compile(SPEC["components"]["schemas"]["MillisecondTimestamp"]["pattern"])
POLICY = json.loads((BASE / "policy.json").read_text(encoding="utf-8"))
MODES = ("webcam", "airpods", "combined")


def validate(name, value):
    schema = {"$ref": f"#/components/schemas/{name}", "components": SPEC["components"]}
    errors = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(value))
    if errors:
        # Never reflect request values, secrets, or raw sensor payloads in an error.
        issues = [{"path": "/" + "/".join(map(str, e.absolute_path)),
                   "code": str(e.validator), "message": "Field does not match the API contract."}
                  for e in errors[:20]]
        raise ApiError(422, "validation_failed", "요청 형식을 확인해 주세요.", issues)


def timestamp(value):
    try:
        if not isinstance(value, str) or not TIMESTAMP_PATTERN.fullmatch(value):
            raise ValueError()
        normalized = value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError, OverflowError):
        raise ApiError(422, "invalid_timestamp", "시간은 밀리초 단위의 RFC3339여야 합니다.") from None


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sample_semantics(sample, policy):
    if sample["quality"] != "valid":
        return
    camera, head = sample["camera_estimate_deg"], sample["head_flexion_deg"]
    mode = sample["active_mode"]
    weights = policy["fusion_weights"]
    expected_angle = (camera * weights["webcam"] + head * weights["airpods"]) if mode == "combined" else (camera if mode == "webcam" else head)
    if not math.isclose(sample["display_angle_deg"], expected_angle, abs_tol=0.000001):
        raise ApiError(422, "angle_mismatch", "참고 각도와 센서 조합이 일치하지 않습니다.")
    caution, high = policy["thresholds_deg"]["caution"], policy["thresholds_deg"]["high"]
    if mode != "combined":
        level = "high" if expected_angle >= high else "caution" if expected_angle >= caution else "normal"
        reason = "within_range" if level == "normal" else "head_flexion" if mode == "airpods" else "forward_shift" if level == "high" else "mixed_caution"
    elif camera >= high:
        level, reason = "high", "combined_high" if head >= high else "forward_shift"
    elif camera < caution and head < caution:
        level, reason = "normal", "within_range"
    else:
        level, reason = "caution", "head_flexion" if camera < caution and head >= high else "mixed_caution"
    if (sample["posture_level"], sample["reason_code"]) != (level, reason):
        raise ApiError(422, "decision_mismatch", "판정과 정책 버전이 일치하지 않습니다.")
