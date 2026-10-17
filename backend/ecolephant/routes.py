from datetime import timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import base64
import json
from uuid import UUID

from flask import Blueprint, current_app, g, jsonify, request

from .auth import require_owner
from .contracts import MODES, POLICY, iso, timestamp, validate
from .errors import ApiError
from .metrics import aggregate, time_buckets, timeline
from . import service

api = Blueprint("api", __name__)


def repo():
    return current_app.extensions["repository"]


def body(schema):
    value = request.get_json()
    validate(schema, value)
    return value


def integer(name, default, minimum=0, maximum=2147483647):
    raw = request.args.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
        if str(value) != raw or not minimum <= value <= maximum:
            raise ValueError()
        return value
    except ValueError:
        raise ApiError(422, "invalid_query", "조회 숫자 범위를 확인해 주세요.") from None


def period(required=False):
    a, b = request.args.get("from"), request.args.get("to")
    if bool(a) != bool(b) or (required and not a):
        raise ApiError(422, "invalid_period", "조회 시작과 끝을 함께 지정해 주세요.")
    if not a:
        return None, None
    low, high = timestamp(a), timestamp(b)
    if low >= high or high - low > timedelta(days=366):
        raise ApiError(422, "invalid_period", "조회 기간은 0일 초과 366일 이하여야 합니다.")
    return low, high


def mode_filter():
    mode = request.args.get("mode")
    if mode is not None and mode not in MODES:
        raise ApiError(422, "invalid_mode", "측정 방식을 확인해 주세요.")
    return mode


def page(items, key):
    limit = integer("limit", 20, 1, 100)
    cursor = request.args.get("cursor")
    items = sorted(items, key=key)
    if cursor:
        try:
            if len(cursor) > 400:
                raise ValueError()
            marker = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
            if not isinstance(marker, list) or len(marker) != 2 or not all(isinstance(x, type(y)) for x, y in zip(marker, key(items[0]) if items else ["", ""])):
                raise ValueError()
            items = [item for item in items if key(item) > marker]
        except (ValueError, TypeError, UnicodeError):
            raise ApiError(422, "invalid_cursor", "페이지 식별자를 확인해 주세요.") from None
    selected = items[:limit]
    next_cursor = base64.urlsafe_b64encode(json.dumps(key(selected[-1]), separators=(",", ":")).encode()).decode() if len(items) > limit else None
    return {"items": selected, "next_cursor": next_cursor}


@api.get("/health")
def health():
    return jsonify(status="ok", contract_version="0.1.0")


@api.get("/api/v1/policies")
@require_owner
def policies():
    return jsonify(items=[{**{k: POLICY[k] for k in ["policy_id", "revision", "release_approved", "camera_mapping_status"]}, "supported_modes": list(MODES)}])


@api.post("/api/v1/sessions")
@require_owner
def create():
    key = request.headers.get("Idempotency-Key", "")
    try:
        UUID(key)
    except ValueError:
        raise ApiError(422, "invalid_idempotency_key", "시작 요청 식별자가 필요합니다.") from None
    return jsonify(service.create_session(repo(), g.owner, key, body("SessionCreate"))), 201


@api.get("/api/v1/sessions")
@require_owner
def sessions():
    low, high = period()
    mode, status = mode_filter(), request.args.get("status")
    if status and status not in {"active", "completed", "abandoned"}:
        raise ApiError(422, "invalid_status", "세션 상태를 확인해 주세요.")
    items = [s for s in repo().list(g.owner) if (not mode or s["requested_mode"] == mode) and (not status or s["status"] == status)
             and (not low or low <= timestamp(s["started_at"]) < high)]
    return jsonify(page(items, lambda s: [s["started_at"], s["id"]]))


@api.get("/api/v1/sessions/<uuid:session_id>")
@require_owner
def detail(session_id):
    return jsonify(repo().load(g.owner, str(session_id))["session"])


@api.delete("/api/v1/sessions/<uuid:session_id>")
@require_owner
def delete(session_id):
    repo().delete(g.owner, str(session_id))
    return "", 204


@api.post("/api/v1/sessions/<uuid:session_id>/samples:batch")
@require_owner
def samples(session_id):
    return jsonify(service.ingest(repo(), g.owner, str(session_id), "samples", body("SampleBatch")["samples"]))


@api.post("/api/v1/sessions/<uuid:session_id>/events:batch")
@require_owner
def events(session_id):
    return jsonify(service.ingest(repo(), g.owner, str(session_id), "events", body("EventBatch")["events"]))


@api.get("/api/v1/sessions/<uuid:session_id>/events")
@require_owner
def list_events(session_id):
    record = repo().load(g.owner, str(session_id))
    return jsonify(page(record["events"].values(), lambda e: [e["elapsed_ms"], e["event_id"]]))


@api.post("/api/v1/sessions/<uuid:session_id>/complete")
@require_owner
def complete(session_id):
    return jsonify(service.complete(repo(), g.owner, str(session_id), body("SessionComplete")))


@api.get("/api/v1/sessions/<uuid:session_id>/timeline")
@require_owner
def get_timeline(session_id):
    record = repo().load(g.owner, str(session_id))
    end = max((s["elapsed_start_ms"] + s["duration_ms"] for s in record["samples"].values()), default=0)
    low, high = integer("from_elapsed_ms", 0), integer("to_elapsed_ms", end, 1)
    resolution = integer("resolution_ms", 60000, 60000, 60000)
    if low > high or high - low > 86400000:
        raise ApiError(422, "invalid_range", "타임라인 조회 범위를 확인해 주세요.")
    return jsonify(session_id=str(session_id), resolution_ms=resolution, buckets=timeline(record, low, high))


@api.get("/api/v1/statistics")
@require_owner
def statistics():
    low, high = period(required=True)
    group_by, zone_name = request.args.get("group_by"), request.args.get("timezone", "Asia/Seoul")
    include = request.args.get("include_active", "false")
    if group_by not in {"day", "hour"} or include not in {"true", "false"}:
        raise ApiError(422, "invalid_query", "통계 조회 조건을 확인해 주세요.")
    try:
        zone = ZoneInfo(zone_name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ApiError(422, "invalid_timezone", "IANA 시간대를 확인해 주세요.") from None
    mode, policy_id = mode_filter(), request.args.get("policy_id")
    records = []
    for session in repo().list(g.owner):
        if session["status"] != "completed" and include != "true":
            continue
        if policy_id and session["policy_id"] != policy_id:
            continue
        if timestamp(session["started_at"]) >= high:
            continue
        record = repo().load(g.owner, session["id"])
        records.append(record)
    summaries, unknown = aggregate(records, low, high)
    groups = [{"active_mode": s["active_mode"], "policy_id": s["policy_id"], "summary": s["metrics"], "buckets": []}
              for s in summaries if not mode or s["active_mode"] == mode]
    for start, end, bucket in time_buckets(low, high, zone, group_by):
        values, _ = aggregate(records, start, end)
        for value in values:
            for group in groups:
                if (group["active_mode"], group["policy_id"]) == (value["active_mode"], value["policy_id"]):
                    group["buckets"].append({**bucket, "metrics": value["metrics"]})
    return jsonify({"from": iso(low), "to": iso(high), "timezone": zone_name, "group_by": group_by,
                    "include_active": include == "true", "groups": groups, "unassigned_unknown_duration_ms": unknown})
