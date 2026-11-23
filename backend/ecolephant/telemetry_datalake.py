import json
from datetime import datetime, timezone

BUCKET_PREFIX = "inha-capstone-20"


def build_s3_partition_key(started_at, session_id):
    """started_at(ISO 문자열 또는 datetime)을 UTC 기준 날짜 파티션 경로로 변환."""
    if isinstance(started_at, str):
        started_at = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)  
    dt = started_at.astimezone(timezone.utc)

    return (f"telemetry/year={dt:%Y}/month={dt:%m}/day={dt:%d}/"
            f"session_{session_id}.json")


def archive_completed_session_to_s3(bucket_name, session_record, s3_put_fn=None):
    if not str(bucket_name).startswith(BUCKET_PREFIX):
        raise ValueError(f"S3 버킷 이름은 반드시 {BUCKET_PREFIX}로 시작해야 합니다.")

    session = session_record["session"]
    s3_key = build_s3_partition_key(session["started_at"], session["id"])
    body = json.dumps(session_record, separators=(",", ":"),
                      sort_keys=True, ensure_ascii=False)
    data = body.encode("utf-8")

    if s3_put_fn is not None:
        s3_put_fn(bucket_name, s3_key, body)

    return {"bucket": bucket_name, "s3_key": s3_key, "bytes": len(data)}