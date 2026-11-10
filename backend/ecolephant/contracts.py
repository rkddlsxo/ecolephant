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


RANK = {"normal": 0, "caution": 1, "high": 2}


def _above(value, band):
    return "high" if value >= band["high"] else "caution" if value >= band["caution"] else "normal"


def _below(value, band):
    return "high" if value <= band["high"] else "caution" if value <= band["caution"] else "normal"


def _worst(a, b):
    return a if RANK[a] >= RANK[b] else b


def change_semantics(sample, policy):
    """draft-web-v1 (DEC-002): webcam judged by change, head drop by AirPods when connected.

    Mirrors ai/src/decision.ts changeWindow. Webcam degrees stay null until the side-view
    experiment validates a mapping (camera_mapping_status == "validated").
    """
    mode, head = sample["active_mode"], sample["head_flexion_deg"]
    forward, drop = sample.get("camera_forward_change"), sample.get("camera_drop_change")
    nose = sample.get("camera_nose_drop_change")
    if sample["camera_estimate_deg"] is not None and policy["camera_mapping_status"] != "validated":
        raise ApiError(422, "camera_angle_unvalidated", "검증되지 않은 웹캠 각도는 저장할 수 없습니다.")
    has_camera = mode in {"webcam", "combined"}
    if has_camera and (forward is None or drop is None):
        raise ApiError(422, "camera_change_missing", "웹캠 판정에 필요한 변화량이 없습니다.")
    if sample["display_angle_deg"] != head:
        raise ApiError(422, "angle_mismatch", "참고 각도와 센서 조합이 일치하지 않습니다.")
    bands = policy["camera_change_thresholds"]
    forward_level = _above(forward, bands["forward"]) if has_camera else "normal"
    if head is not None:
        drop_level = _above(head, policy["thresholds_deg"])
    else:
        drop_level = _below(drop, bands["drop"])
        if nose is not None:
            drop_level = _worst(drop_level, _below(nose, bands["nose_drop"]))
    level = _worst(forward_level, drop_level)
    forward_on, drop_on = forward_level != "normal", drop_level != "normal"
    posture = "combined" if forward_on and drop_on else "chin_forward" if forward_on else "head_down" if drop_on else None
    if level == "normal":
        reason = "within_range"
    elif level == "caution":
        reason = "head_flexion" if posture == "head_down" else "mixed_caution"
    else:
        reason = {"chin_forward": "forward_shift", "head_down": "head_flexion"}.get(posture, "combined_high")
    if (sample["posture_level"], sample["reason_code"], sample.get("posture_type")) != (level, reason, posture):
        raise ApiError(422, "decision_mismatch", "판정과 정책 버전이 일치하지 않습니다.")


def sample_semantics(sample, policy):
    if sample["quality"] != "valid":
        return
    if policy.get("camera_judgement", "angle") == "change":
        return change_semantics(sample, policy)
    camera, head = sample["camera_estimate_deg"], sample["head_flexion_deg"]
    if (camera is None and sample["active_mode"] != "airpods") or sample["display_angle_deg"] is None:
        raise ApiError(422, "angle_missing", "이 정책은 각도로 판정합니다.")
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
