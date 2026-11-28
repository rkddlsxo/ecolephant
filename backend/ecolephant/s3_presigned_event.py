"""
1) S3 Presigned URL: 비공개 S3 버킷의 AI 리포트를 5분(300초) 동안만 열리고 자동 폐기되게 하는 일회용 서명 다운로드 링크
2) S3 Event Notification -> Lambda 무인 트리거: S3에 측정 파일이 업로드되는 순간(ObjectCreated) 백엔드 개입 없이 AI 분석 자동 실행
"""
import hashlib
import hmac
import time
import urllib.parse


def create_s3_presigned_download_url(
    bucket_name,
    object_key,
    expires_in_seconds=300,
    secret_key="inha-capstone-20-secret",
    now_fn=time.time,
):
    """비공개 S3 리포트 파일에 대해 최대 300초(5분) 동안만 유효한 서명된 다운로드 URL을 생성"""
    if not str(bucket_name).startswith("inha-capstone-20"):
        raise ValueError("S3 버킷 이름은 반드시 inha-capstone-20으로 시작해야 합니다.")

    # 일회용 다운로드 링크의 수명을 길게주면 그 링크가 단톡방에 유출되었을 때 남들도 다 열어볼 수 있어서, 최대 5분으로 제한
    if not (1 <= int(expires_in_seconds) <= 300):
        raise ValueError("Presigned URL 만료 시간은 1~300초 사이여야 합니다.")

    expires_at = int(now_fn()) + int(expires_in_seconds)
    payload_to_sign = f"GET\n{bucket_name}\n{object_key}\n{expires_at}".encode("utf-8")
    signature = hmac.new(str(secret_key).encode("utf-8"), payload_to_sign, hashlib.sha256).hexdigest()
    safe_key = urllib.parse.quote(str(object_key).lstrip("/"))
    return (
        f"https://{bucket_name}.s3.ap-northeast-2.amazonaws.com/{safe_key}"
        f"?X-Amz-Expires={int(expires_in_seconds)}&X-Amz-ExpiresAt={expires_at}&X-Amz-Signature={signature}"
    )


def handle_s3_object_created_trigger(s3_event, ai_report_fn):
    """S3에 새 측정 파일이 업로드되었을 때 AWS가 자동으로 보내주는 이벤트를 받아 무인으로 AI 리포트를 생성"""
    triggered_keys = []
    for record in s3_event.get("Records", []):
        event_name = record.get("eventName", "")
        if not event_name.startswith("ObjectCreated:"):
            continue
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        ai_report_fn(bucket, key)
        triggered_keys.append(key)
    return {"triggered_count": len(triggered_keys), "keys": triggered_keys}
