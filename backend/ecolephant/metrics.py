from collections import defaultdict
from copy import deepcopy
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
    previous = None
    for sample in record["samples"].values():
        if sample["elapsed_start_ms"] <= elapsed < sample["elapsed_start_ms"] + sample["duration_ms"]:
            return sample["active_mode"]
        if sample["elapsed_start_ms"] + sample["duration_ms"] == elapsed:
            previous = sample["active_mode"]
    if previous is not None:
        return previous
    return record["session"]["requested_mode"]


def aggregate(records, low=None, high=None):
    groups = defaultdict(list)
    event_groups = defaultdict(list)
    unknown = 0
    for record in records:
        base = timestamp(record["session"]["started_at"])
        a = max(0, (low - base) // timedelta(milliseconds=1)) if low else 0
        b = (high - base) // timedelta(milliseconds=1) if high else None
        for sample, _, duration in windows(record, a, b):
            mode = sample["active_mode"]
            if mode not in MODES:
                unknown += duration
                continue
            groups[(mode, record["session"]["policy_id"])].append((sample, duration))
        delivered, corrections = {}, {}
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
            if (low and absolute < low) or (high and absolute >= high):
                continue
            mode = mode_at(record, elapsed)
            if mode in MODES:
                key = (mode, record["session"]["policy_id"])
                groups.setdefault(key, [])
                event_groups[key].append((elapsed, corrections.get(alert_id)))
    result = []
    for (mode, policy_id), samples in sorted(groups.items()):
        m, weighted, angled = empty_metrics(), 0, 0
        for sample, duration in samples:
            if sample["quality"] != "valid":
                continue
            m["valid_duration_ms"] += duration
            m[sample["posture_level"] + "_duration_ms"] += duration
            # Change-based webcam windows carry no degrees; the mean covers measured angles only.
            if sample["display_angle_deg"] is not None:
                weighted += sample["display_angle_deg"] * duration
                angled += duration
            if sample["posture_level"] == "high" and sample["reason_code"] in {"combined_high", "forward_shift"}:
                m["forward_head_suspected_ms"] += duration
        valid = m["valid_duration_ms"]
        if valid:
            m["mean_display_angle_deg"] = weighted / angled if angled else None
            m["within_range_percent"] = m["normal_duration_ms"] / valid * 100
        delays = []
        for elapsed, correction in event_groups[(mode, policy_id)]:
            m["first_stage_alert_count"] += 1
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


def build_append_state(record):
    samples, session = record["samples"], record["session"]
    acknowledged = session["acknowledged_through_seq"]
    if acknowledged != max(samples, default=0):
        return None
    tail = samples.get(acknowledged)
    weighted, angled = {}, {}
    for sample in samples.values():
        mode = sample["active_mode"]
        if mode in MODES and sample["quality"] == "valid":
            angle, duration = sample["display_angle_deg"], sample["duration_ms"]
            weighted[mode] = weighted.get(mode, 0) + (angle * duration if angle is not None else 0)
            angled[mode] = angled.get(mode, 0) + (duration if angle is not None else 0)
    delivered = [event["elapsed_ms"] for event in record["events"].values()
                 if event["type"] == "alert_delivery" and event["data"]["stage"] == 1
                 and event["data"]["result"] == "delivered"]
    return {"version": 1, "tail_seq": acknowledged,
            "tail_end_ms": tail["elapsed_start_ms"] + tail["duration_ms"] if tail else 0,
            "tail_epoch": tail["calibration_epoch"] if tail else record["create"]["initial_calibration_epoch"],
            "weighted": weighted, "angled": angled, "latest_delivery_ms": max(delivered, default=None)}


def append_sample_metrics(record, samples):
    session, state = record["session"], record["append_state"]
    groups = {(group["active_mode"], group["policy_id"]): group for group in session["summaries"]}
    if "angled" not in state:
        # States saved before change-based policies existed: every valid window had an angle.
        state["angled"] = {group["active_mode"]: group["metrics"]["valid_duration_ms"] for group in session["summaries"]}
    for sample in samples:
        mode, duration = sample["active_mode"], sample["duration_ms"]
        if mode not in MODES:
            session["unassigned_unknown_duration_ms"] += duration
            continue
        key = (mode, session["policy_id"])
        group = groups.setdefault(key, {"active_mode": mode, "policy_id": session["policy_id"], "metrics": empty_metrics()})
        if sample["quality"] != "valid":
            continue
        metrics = group["metrics"]
        metrics["valid_duration_ms"] += duration
        metrics[sample["posture_level"] + "_duration_ms"] += duration
        angle = sample["display_angle_deg"]
        state["weighted"][mode] = state["weighted"].get(mode, 0) + (angle * duration if angle is not None else 0)
        state["angled"][mode] = state["angled"].get(mode, 0) + (duration if angle is not None else 0)
        if sample["posture_level"] == "high" and sample["reason_code"] in {"combined_high", "forward_shift"}:
            metrics["forward_head_suspected_ms"] += duration
    for (mode, _), group in groups.items():
        metrics = group["metrics"]
        valid = metrics["valid_duration_ms"]
        if valid:
            angled = state["angled"].get(mode, 0)
            metrics["mean_display_angle_deg"] = state["weighted"][mode] / angled if angled else None
            metrics["within_range_percent"] = metrics["normal_duration_ms"] / valid * 100
    session["summaries"] = [groups[key] for key in sorted(groups)]


def valid_timeline_bucket(bucket, start, duration):
    try:
        fields = ("normal_ms", "caution_ms", "high_ms", "unknown_ms")
        values = [bucket[key] for key in fields]
        modes = bucket["active_modes"]
        return (type(bucket["elapsed_start_ms"]) is int and bucket["elapsed_start_ms"] == start
                and type(bucket["duration_ms"]) is int and bucket["duration_ms"] == duration
                and isinstance(modes, list) and len(set(modes)) == len(modes) and all(mode in MODES for mode in modes)
                and all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in values)
                and sum(values) == duration)
    except (KeyError, TypeError):
        return False


def valid_timeline_cache(cache, tail_end):
    if (not isinstance(cache, dict) or type(cache.get("version")) is not int
            or cache["version"] != 1 or "partial" not in cache):
        return False
    completed, partial = cache.get("completed_until_ms"), cache.get("partial")
    if (not isinstance(completed, int) or isinstance(completed, bool) or completed < 0
            or completed % 60000 or type(tail_end) is not int or completed > tail_end):
        return False
    remaining = tail_end - completed
    if remaining == 0:
        return partial is None
    return 0 < remaining < 60000 and valid_timeline_bucket(partial, completed, remaining)


def extend_timeline_cache(state, samples):
    tail_end, original = state.get("tail_end_ms"), state.get("timeline_cache")
    if not valid_timeline_cache(original, tail_end):
        return None, []
    cache, completed = deepcopy(original), []
    cursor = tail_end
    for sample in samples:
        if sample["elapsed_start_ms"] != cursor:
            return None, []
        remaining = sample["duration_ms"]
        while remaining:
            bucket = cache["partial"]
            if bucket is None:
                bucket = {"elapsed_start_ms": cache["completed_until_ms"], "duration_ms": 0,
                          "normal_ms": 0, "caution_ms": 0, "high_ms": 0,
                          "unknown_ms": 0, "active_modes": []}
                cache["partial"] = bucket
            amount = min(remaining, 60000 - bucket["duration_ms"])
            bucket["duration_ms"] += amount
            if sample["quality"] == "valid":
                bucket[sample["posture_level"] + "_ms"] += amount
            else:
                bucket["unknown_ms"] += amount
            mode = sample["active_mode"]
            if mode in MODES and mode not in bucket["active_modes"]:
                bucket["active_modes"].append(mode)
            cursor += amount
            remaining -= amount
            if bucket["duration_ms"] == 60000:
                completed.append(bucket)
                cache["completed_until_ms"] += 60000
                cache["partial"] = None
    if not valid_timeline_cache(cache, cursor):
        return None, []
    return cache, completed


def indexed_timeline(rows, cache, low, stop):
    partial = cache["partial"]
    buckets = list(rows)
    if partial is not None and low <= partial["elapsed_start_ms"] < stop:
        buckets.append(partial)
    position = low
    for bucket in buckets:
        duration = min(60000, stop - position)
        if duration <= 0 or not valid_timeline_bucket(bucket, position, duration):
            return None
        position += duration
    return buckets if position == stop else None


def timeline(record, low, high):
    buckets = []
    for start in range(low, high, 60000):
        duration = min(60000, high - start)
        buckets.append({"elapsed_start_ms": start, "duration_ms": duration,
                        "normal_ms": 0, "caution_ms": 0, "high_ms": 0,
                        "unknown_ms": duration, "active_modes": []})
    for sample, start, overlap in windows(record, low, high):
        end = start + overlap
        while start < end:
            index = (start - low) // 60000
            bucket = buckets[index]
            piece = min(end, bucket["elapsed_start_ms"] + bucket["duration_ms"]) - start
            if sample["quality"] == "valid":
                bucket[sample["posture_level"] + "_ms"] += piece
                bucket["unknown_ms"] -= piece
            if sample["active_mode"] in MODES and sample["active_mode"] not in bucket["active_modes"]:
                bucket["active_modes"].append(sample["active_mode"])
            start += piece
    return buckets


def time_buckets(low, high, zone, group_by):
    current = low
    while current < high:
        local = current.astimezone(zone)
        if group_by == "hour":
            next_time = current + timedelta(seconds=3600 - local.minute * 60 - local.second, microseconds=-local.microsecond)
            # A UTC offset may change before the next wall-clock hour (e.g. Chatham).
            probe = next_time - timedelta(microseconds=1)
            if probe.astimezone(zone).utcoffset() != local.utcoffset():
                left, right = current, probe
                while right - left > timedelta(microseconds=1):
                    middle = left + (right - left) // 2
                    if middle.astimezone(zone).utcoffset() == local.utcoffset():
                        left = middle
                    else:
                        right = middle
                next_time = right
        else:
            boundary = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            next_time = boundary.astimezone(current.tzinfo)
        end = min(high, next_time)
        yield current, end, {"starts_at": iso(current), "ends_at": iso(end)}
        current = end
