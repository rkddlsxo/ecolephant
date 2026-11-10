from copy import deepcopy
from datetime import timedelta
from uuid import uuid4

from .contracts import canonical, iso, timestamp, sample_semantics
from .errors import ApiError
from .metrics import append_sample_metrics, build_append_state, extend_timeline_cache, refresh
from .policies import LEGACY_POLICY, session_policy


def conflict(message):
    raise ApiError(409, "sequence_conflict", message)


def require_real_policy(mode, policy):
    if not policy["release_approved"]:
        raise ApiError(409, "policy_not_approved", "실제 측정에 승인된 정책이 필요합니다.")
    # The mapping check guards webcam *degrees*. A change-based policy stores no webcam degrees
    # (contracts.change_semantics rejects them until validated), so only team approval applies.
    angle_based = policy.get("camera_judgement", "angle") == "angle"
    if mode in {"webcam", "combined"} and angle_based and policy["camera_mapping_status"] != "validated":
        raise ApiError(409, "camera_mapping_unvalidated", "카메라 측정 기준을 먼저 검증해 주세요.")


def create_session(repo, owner, key, payload, policies):
    payload["data_source"] = payload.get("data_source", "demo")
    payload["started_at"] = iso(timestamp(payload["started_at"]))
    existing = repo.find_create(owner, key, payload)
    if existing is not None:
        return existing["session"]
    policy = policies.get(payload["policy_id"])
    if policy is None:
        raise ApiError(404, "policy_not_found", "정책을 찾을 수 없습니다.")
    if payload["data_source"] == "real":
        require_real_policy(payload["requested_mode"], policy)
    # Seed the immutable pre-registry draft before allowing any new ID registration.
    repo.ensure_policy(LEGACY_POLICY)
    repo.ensure_policy(policy)
    session = {"id": str(uuid4()), **{k: payload[k] for k in ["client_session_id", "started_at", "requested_mode", "policy_id", "data_source"]},
               "ended_at": None, "status": "active", "final_seq": None, "final_event_seq": None,
               "acknowledged_through_seq": 0, "acknowledged_through_event_seq": 0,
               "summaries": [], "unassigned_unknown_duration_ms": 0}
    record = {"session": session, "create": payload, "policy": policy, "revision": 0}
    record["append_state"] = build_append_state({**record, "samples": {}, "events": {}})
    record["append_state"]["timeline_cache"] = {"version": 1, "completed_until_ms": 0, "partial": None}
    return repo.create(owner, key, payload, record)["session"]


def check_samples(record):
    samples = sorted(record["samples"].values(), key=lambda x: x["seq"])
    initial_epoch = record["create"]["initial_calibration_epoch"]
    policy = session_policy(record)
    for index, sample in enumerate(samples):
        if record["session"].get("data_source", "demo") == "real":
            require_real_policy(sample["active_mode"], policy)
        sample_semantics(sample, policy)
        if sample["calibration_epoch"] < initial_epoch:
            conflict("보정 버전이 시작 버전보다 작습니다.")
        if sample["seq"] == 1 and sample["elapsed_start_ms"] != 0:
            conflict("첫 창은 세션 시작 시각부터 기록해야 합니다.")
        if index:
            prev = samples[index - 1]
            end = prev["elapsed_start_ms"] + prev["duration_ms"]
            if end > sample["elapsed_start_ms"] or prev["calibration_epoch"] > sample["calibration_epoch"]:
                conflict("창의 시간 또는 보정 순서가 잘못되었습니다.")
            if prev["seq"] + 1 == sample["seq"] and end != sample["elapsed_start_ms"]:
                conflict("연속 창 사이의 누락 구간도 무효 창으로 기록해야 합니다.")


def check_events(record, final=False):
    events = list(record["events"].values())
    policy = session_policy(record)
    identities, deliveries, corrections = set(), {}, set()
    max_elapsed = max((s["elapsed_start_ms"] + s["duration_ms"] for s in record["samples"].values()), default=0)
    for event in events:
        if event["event_id"] in identities:
            conflict("이벤트 ID가 중복되었습니다.")
        identities.add(event["event_id"])
        if final and event["elapsed_ms"] > max_elapsed:
            conflict("이벤트가 세션 종료 시각을 넘습니다.")
        if event["type"] == "alert_delivery":
            d = event["data"]
            identity = (d["alert_id"], d["stage"], d["channel"])
            if identity in deliveries:
                conflict("같은 알림 단계와 채널은 한 번만 기록할 수 있습니다.")
            deliveries[identity] = event
    first = {}
    for (alert_id, stage, _), event in deliveries.items():
        if stage == 1 and event["data"]["result"] == "delivered":
            first[alert_id] = min(first.get(alert_id, event["elapsed_ms"]), event["elapsed_ms"])
    for event in events:
        d = event["data"]
        needs_first = event["type"] == "correction_observed" or (event["type"] == "alert_delivery" and d["stage"] == 2)
        if needs_first:
            start = first.get(d["alert_id"])
            if start is None:
                if final:
                    conflict("알림의 선행 전달 기록이 없습니다.")
            elif event["elapsed_ms"] < start:
                conflict("교정과 2차 알림은 1차 알림 이후여야 합니다.")
            elif event["type"] == "alert_delivery" and event["elapsed_ms"] - start < policy["alerts"]["second_after_first_ms"]:
                conflict("2차 알림 지속 시간이 부족합니다.")
        if event["type"] == "correction_observed":
            if d["alert_id"] in corrections:
                conflict("같은 알림의 교정 결과를 중복 기록할 수 없습니다.")
            corrections.add(d["alert_id"])


def append_contiguous_samples(repo, owner, record, items):
    session, state = record["session"], record.get("append_state")
    if session["status"] != "active" or not isinstance(state, dict) or state.get("version") != 1 or not items:
        return None
    tail_seq, tail_end, tail_epoch = state.get("tail_seq"), state.get("tail_end_ms"), state.get("tail_epoch")
    if (not all(isinstance(value, int) and not isinstance(value, bool) for value in (tail_seq, tail_end, tail_epoch))
            or tail_seq != session["acknowledged_through_seq"] or not isinstance(state.get("weighted"), dict)):
        return None
    latest = state.get("latest_delivery_ms")
    if latest is not None and (not isinstance(latest, int) or latest >= tail_end):
        return None
    summaries = session["summaries"]
    if (len({(group["active_mode"], group["policy_id"]) for group in summaries}) != len(summaries)
            or any(group["policy_id"] != session["policy_id"]
                   or (group["metrics"]["valid_duration_ms"] and group["active_mode"] not in state["weighted"])
                   for group in summaries)):
        return None
    if any(item["seq"] != tail_seq + index for index, item in enumerate(items, start=1)):
        return None
    policy = session_policy(record)
    for item in items:
        if record["session"].get("data_source", "demo") == "real":
            require_real_policy(item["active_mode"], policy)
        sample_semantics(item, policy)
        if item["elapsed_start_ms"] != tail_end or item["calibration_epoch"] < tail_epoch:
            conflict("창의 시간 또는 보정 순서가 잘못되었습니다.")
        tail_seq, tail_end, tail_epoch = item["seq"], item["elapsed_start_ms"] + item["duration_ms"], item["calibration_epoch"]
    cache, completed = extend_timeline_cache(state, items)
    if cache is None:
        state.pop("timeline_cache", None)
    else:
        state["timeline_cache"] = cache
    append_sample_metrics(record, items)
    state.update(tail_seq=tail_seq, tail_end_ms=tail_end, tail_epoch=tail_epoch)
    session["acknowledged_through_seq"] = tail_seq
    repo.commit(owner, record, samples=items, timeline_buckets=completed)
    return {"accepted_count": len(items), "duplicate_count": 0, "acknowledged_through_seq": tail_seq}


def ingest(repo, owner, session_id, kind, items):
    if kind == "samples":
        metadata = repo.load_metadata(owner, session_id)
        receipt = append_contiguous_samples(repo, owner, metadata, items)
        if receipt is not None:
            return receipt
    record = repo.load(owner, session_id)
    old_state = deepcopy(record.get("append_state"))
    field, sequence = ("samples", "seq") if kind == "samples" else ("events", "event_seq")
    existing, fresh, duplicate = record[field], [], 0
    for item in items:
        seq = item[sequence]
        if seq in existing:
            if canonical(existing[seq]) != canonical(item):
                conflict("동일한 순서 번호의 내용이 다릅니다.")
            duplicate += 1
        else:
            if record["session"]["status"] != "active":
                conflict("완료된 세션에는 새 결과를 추가할 수 없습니다.")
            existing[seq] = item
            fresh.append(item)
    check_samples(record)
    check_events(record)
    refresh(record)
    if fresh:
        state = build_append_state(record)
        completed = []
        if state is None:
            record.pop("append_state", None)
        else:
            if isinstance(old_state, dict):
                ordered = sorted(fresh, key=lambda item: item["seq"]) if kind == "samples" else []
                old_seq = old_state.get("tail_seq")
                contiguous = (kind == "events" and state["tail_seq"] == old_seq
                              and state["tail_end_ms"] == old_state.get("tail_end_ms"))
                if kind == "samples" and isinstance(old_seq, int):
                    contiguous = (all(item["seq"] == old_seq + index for index, item in enumerate(ordered, start=1))
                                  and state["tail_seq"] == old_seq + len(ordered))
                if contiguous:
                    cache, rows = extend_timeline_cache(old_state, ordered)
                    if cache is not None and (cache["completed_until_ms"]
                            + (cache["partial"]["duration_ms"] if cache["partial"] else 0) == state["tail_end_ms"]):
                        state["timeline_cache"], completed = cache, rows
            record["append_state"] = state
        repo.commit(owner, record, samples=fresh if kind == "samples" else (),
                    events=fresh if kind == "events" else (), timeline_buckets=completed)
    ack = "acknowledged_through_" + sequence
    return {"accepted_count": len(fresh), "duplicate_count": duplicate, ack: record["session"][ack]}


def complete(repo, owner, session_id, payload):
    record = repo.load(owner, session_id)
    session = record["session"]
    payload["ended_at"] = iso(timestamp(payload["ended_at"]))
    if session["status"] != "active":
        if all(session[key] == value for key, value in payload.items()):
            return session
        conflict("기존 종료 요청과 내용이 다릅니다.")
    refresh(record)
    for field, sequence, final in [("samples", "seq", "final_seq"), ("events", "event_seq", "final_event_seq")]:
        if max(record[field], default=0) != payload[final] or session["acknowledged_through_" + sequence] != payload[final]:
            conflict("아직 전송되지 않은 창 또는 이벤트가 있습니다.")
    elapsed = max((s["elapsed_start_ms"] + s["duration_ms"] for s in record["samples"].values()), default=0)
    expected = timestamp(session["started_at"]) + timedelta(milliseconds=elapsed)
    if timestamp(payload["ended_at"]) != expected:
        conflict("종료 시각과 마지막 창의 끝이 일치하지 않습니다.")
    check_samples(record)
    check_events(record, final=True)
    session.update(payload, status="completed")
    repo.commit(owner, record)
    return session
