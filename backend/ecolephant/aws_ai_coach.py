"""[AWS Lambda & Bedrock 대체 LLM API 연동]
측정 종료 후 집계된 자세 통계(바른 자세 비율, 주의 횟수 — 카메라 원본 이미지 절대 미포함!)를 바탕으로
넥스트클라우드 Bedrock 대체 LLM API를 호출해 맞춤형 자세 코칭 문구를 생성하고,
아직 API 키 발급 전(3일 대기 중)이거나 장애 시에는 규칙 기반 코칭 문구로 안전하게 Fallback하는 모듈입니다.
"""
import json
import os
import urllib.request


def build_posture_coach_prompt(stats_summary):
    """집계된 숫자 통계만 프롬프트로 구성합니다 (카메라 이미지·관절점·원시 IMU 데이터 미포함)."""
    good_ratio = round(float(stats_summary.get("good_ratio", 0.0)) * 100, 1)
    warning_count = int(stats_summary.get("warning_count", 0))
    dominant_issue = stats_summary.get("dominant_issue", "forward_head")
    return (
        f"사용자 자세 측정 요약: 바른 자세 유지율 {good_ratio}%, "
        f"경고 발생 {warning_count}회, 주요 주의 유형: {dominant_issue}. "
        "의학적 진단 표현 없이 2문장 이내로 친근한 자세 교정 피드백과 스트레칭 가이드를 작성해 주세요."
    )


def fallback_coach_message(stats_summary):
    """Bedrock API 키 발급 전(영업일 3일 대기 중)이거나 호출 한도 초과 시 즉시 반환하는 로컬 코칭 문구입니다."""
    good_ratio = round(float(stats_summary.get("good_ratio", 0.0)) * 100, 1)
    if good_ratio >= 80.0:
        return f"바른 자세 유지율이 {good_ratio}%로 매우 훌륭합니다! 50분마다 가벼운 목·어깨 기지개로 컨디션을 유지해 보세요."
    return f"이번 세션 바른 자세 유지율은 {good_ratio}%입니다. 턱을 살짝 당겨 귀와 어깨선을 맞추고 30초간 흉쇄유돌근 스트레칭을 진행해 보세요."


def generate_ai_posture_coaching(stats_summary, api_url=None, api_key=None, transport_fn=None):
    """넥스트클라우드 Bedrock 대체 LLM API로 코칭 리포트를 생성하고, 키 미설정·장애 시 Fallback 문구를 반환합니다."""
    api_url = api_url if api_url is not None else os.getenv("NXTCLOUD_BEDROCK_API_URL", "")
    api_key = api_key if api_key is not None else os.getenv("NXTCLOUD_BEDROCK_API_KEY", "")
    prompt = build_posture_coach_prompt(stats_summary)

    # 아직 슬랙 DM으로 API 키를 받기 전이면 에러 없이 Fallback 코칭 문구를 즉시 반환합니다!
    if not api_url or not api_key:
        return {"source": "fallback_rule", "prompt": prompt, "coaching": fallback_coach_message(stats_summary)}

    try:
        if transport_fn is not None:
            response_data = transport_fn(api_url, api_key, prompt)
        else:
            req = urllib.request.Request(
                api_url,
                data=json.dumps({"prompt": prompt, "max_tokens": 200}).encode("utf-8"),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                response_data = json.loads(resp.read().decode("utf-8"))
        text = response_data.get("coaching") or response_data.get("completion") or fallback_coach_message(stats_summary)
        return {"source": "bedrock_llm", "prompt": prompt, "coaching": text}
    except Exception:
        return {"source": "fallback_rule", "prompt": prompt, "coaching": fallback_coach_message(stats_summary)}


def lambda_handler(event, _context=None):
    """AWS Lambda (SafeRole-inha-capstone-20) 및 API Gateway HTTP API 연동 엔트리포인트입니다."""
    raw_body = event.get("body") if isinstance(event, dict) else None
    if isinstance(raw_body, str) and raw_body:
        payload = json.loads(raw_body)
    elif isinstance(raw_body, dict):
        payload = raw_body
    elif isinstance(event, dict):
        payload = event
    else:
        payload = {}

    result = generate_ai_posture_coaching(payload)
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(result, ensure_ascii=False),
    }
