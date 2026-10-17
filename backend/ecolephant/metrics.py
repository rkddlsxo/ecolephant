from collections import defaultdict
from datetime import timedelta

from .contracts import MODES, timestamp, iso


def empty_metrics():
    return {"valid_duration_ms": 0, "normal_duration_ms": 0, "caution_duration_ms": 0,
            "high_duration_ms": 0, "forward_head_suspected_ms": 0,
            "mean_display_angle_deg": None, "within_range_percent": None,
            "first_stage_alert_count": 0, "corrected_alert_count": 0,
            "unknown_correction_count": 0, "mean_correction_ms": None}


def windows(record, low=0, high=None):
    for sample in record.get("samples", {}).values():
        start = max(low, sample["elapsed_start_ms"])
        end = sample["elapsed_start_ms"] + sample["duration_ms"]
        if high is not None:
            end = min(high, end)
        if end > start:
            yield sample, start, end - start


def mode_at(record, elapsed):
    for sample in record["samples"].values():
        if sample["elapsed_start_ms"] <= elapsed < sample["elapsed_start_ms"] + sample["duration_ms"]:
            return sample["active_mode"]
    return record["session"]["requested_mode"]


def aggregate(records, low=None, high=None):
    groups = defaultdict(list)
    unknown = 0
    for record in records:
        base = timestamp(record["session"]["started_at"])
        a = max(0, int((low - base).total_seconds() * 1000)) if low else 0
        b = int((high - base).total_seconds() * 1000) if high else None
        for sample, _, duration in windows(record, a, b):
            mode = sample["active_mode"]
            if mode not in MODES:
                unknown += duration
                continue
            groups[(mode, record["session"]["policy_id"])].append((sample, duration))
    result = []
    for (mode, policy_id), samples in sorted(groups.items()):
        m, weighted = empty_metrics(), 0
        for sample, duration in samples:
            if sample["quality"] != "valid":
                continue
            m["valid_duration_ms"] += duration
            m[sample["posture_level"] + "_duration_ms"] += duration
            weighted += sample["display_angle_deg"] * duration
            if sample["posture_level"] == "high" and sample["reason_code"] in {"combined_high", "forward_shift"}:
                m["forward_head_suspected_ms"] += duration
        valid = m["valid_duration_ms"]
        if valid:
            m["mean_display_angle_deg"] = weighted / valid
            m["within_range_percent"] = m["normal_duration_ms"] / valid * 100
        delays = []
        for record in records:
            if record["session"]["policy_id"] != policy_id:
                continue
            base = timestamp(record["session"]["started_at"])
            delivered = {}
            corrections = {}
            for event in record.get("events", {}).values():
                data = event["data"]
                if event["type"] == "alert_delivery" and data["stage"] == 1 and data["result"] == "delivered":
                    old = delivered.get(data["alert_id"])
                    if old is None or event["elapsed_ms"] < old:
                        delivered[data["alert_id"]] = event["elapsed_ms"]
                elif event["type"] == "correction_observed":
                    corrections[data["alert_id"]] = event
            for alert_id, elapsed in delivered.items():
                absolute = base + timedelta(milliseconds=elapsed)
                if mode_at(record, elapsed) != mode or (low and absolute < low) or (high and absolute >= high):
                    continue
                m["first_stage_alert_count"] += 1
                correction = corrections.get(alert_id)
                if correction and correction["data"]["outcome"] == "corrected":
                    m["corrected_alert_count"] += 1
                    delays.append(correction["elapsed_ms"] - elapsed)
                else:
                    m["unknown_correction_count"] += 1
        m["mean_correction_ms"] = sum(delays) / len(delays) if delays else None
        result.append({"active_mode": mode, "policy_id": policy_id, "metrics": m})
    return result, unknown


def refresh(record):
    session = record["session"]
    session["summaries"], session["unassigned_unknown_duration_ms"] = aggregate([record])
    for field, sequence in [("samples", "seq"), ("events", "event_seq")]:
        acknowledged = 0
        while acknowledged + 1 in record[field]:
            acknowledged += 1
        session["acknowledged_through_" + sequence] = acknowledged


def timeline(record, low, high):
    buckets = []
    for start in range(low, high, 60000):
        duration = min(60000, high - start)
        bucket = {"elapsed_start_ms": start, "duration_ms": duration,
                  "normal_ms": 0, "caution_ms": 0, "high_ms": 0,
                  "unknown_ms": duration, "active_modes": []}
        for sample, _, overlap in windows(record, start, start + duration):
            if sample["quality"] == "valid":
                bucket[sample["posture_level"] + "_ms"] += overlap
                bucket["unknown_ms"] -= overlap
            if sample["active_mode"] in MODES and sample["active_mode"] not in bucket["active_modes"]:
                bucket["active_modes"].append(sample["active_mode"])
        buckets.append(bucket)
    return buckets


def time_buckets(low, high, zone, group_by):
    current = low
    while current < high:
        local = current.astimezone(zone)
        if group_by == "hour":
            # Advance in UTC to preserve both occurrences of a DST repeated hour.
            boundary = local.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
            next_time = current + timedelta(seconds=3600 - local.minute * 60 - local.second, microseconds=-local.microsecond)
        else:
            boundary = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            next_time = boundary.astimezone(current.tzinfo)
        end = min(high, next_time)
        yield current, end, {"starts_at": iso(current), "ends_at": iso(end)}
        current = end
