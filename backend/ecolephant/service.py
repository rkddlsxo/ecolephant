from datetime import timedelta
from uuid import uuid4

from .contracts import POLICY, canonical, iso, timestamp, sample_semantics
from .errors import ApiError
from .metrics import refresh


def conflict(message):
    raise ApiError(409, "sequence_conflict", message)


def create_session(repo, owner, key, payload):
    if payload["policy_id"] != POLICY["policy_id"]:
        raise ApiError(404, "policy_not_found", "정책을 찾을 수 없습니다.")
    payload["data_source"] = payload.get("data_source", "demo")
    payload["started_at"] = iso(timestamp(payload["started_at"]))
    session = {"id": str(uuid4()), **{k: payload[k] for k in ["client_session_id", "started_at", "requested_mode", "policy_id", "data_source"]},
               "ended_at": None, "status": "active", "final_seq": None, "final_event_seq": None,
               "acknowledged_through_seq": 0, "acknowledged_through_event_seq": 0,
               "summaries": [], "unassigned_unknown_duration_ms": 0}
    return repo.create(owner, key, payload, {"session": session, "create": payload, "revision": 0})["session"]


def check_samples(record):
    samples = sorted(record["samples"].values(), key=lambda x: x["seq"])
    initial_epoch = record["create"]["initial_calibration_epoch"]
    for index, sample in enumerate(samples):
        sample_semantics(sample)
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
            elif event["type"] == "alert_delivery" and event["elapsed_ms"] - start < POLICY["alerts"]["second_after_first_ms"]:
                conflict("2차 알림 지속 시간이 부족합니다.")
        if event["type"] == "correction_observed":
            if d["alert_id"] in corrections:
                conflict("같은 알림의 교정 결과를 중복 기록할 수 없습니다.")
            corrections.add(d["alert_id"])


def ingest(repo, owner, session_id, kind, items):
    record = repo.load(owner, session_id)
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
        repo.commit(owner, record, samples=fresh if kind == "samples" else (), events=fresh if kind == "events" else ())
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
