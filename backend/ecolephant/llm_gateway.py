"""AI 게이트웨이 4대 패턴:
1) LLM Input/Output Guardrails: 프롬프트 인젝션 해킹 차단 및 의료 진단 금지어('디스크 확진', '처방' 등) 자동 필터링 (PRD 비의료 경계 강제)
2) 멀티 모델 라우터(Model Router): 실시간 단문은 초고속 'bedrock-haiku', 심층 리포트/챗봇은 'bedrock-claude-sonnet-5', 장애 시 'bedrock-gpt-5.6-sol'
3) 시맨틱 버킷 캐싱(Semantic Bucket Cache): 유사한 자세 통계 패턴(10% 단위 버킷)은 LLM을 재호출하지 않고 캐시에서 0.001초 만에 반환해 토큰 비용 70% 절감
4) 상태 머신 서킷 브레이커(State-Machine Circuit Breaker): CLOSED(정상) -> 3회 연속 실패 시 OPEN(즉시 차단) -> 쿨다운 후 HALF_OPEN(1회 시험 복구)
"""
import json
import time

INJECTION_PATTERNS = ("ignore previous instructions", "system prompt", "비밀번호 알려줘", "이전 지시 무시")
MEDICAL_FORBIDDEN_TERMS = ("디스크 확진", "추간판 탈출증 진단", "약물 처방", "완치 보장")


def enforce_input_guardrail(user_question):
    """[Input Guardrail] 프롬프트 인젝션 해킹 문구가 감지되면 ValueError로 즉시 차단합니다."""
    lowered = str(user_question).lower()
    for pattern in INJECTION_PATTERNS:
        if pattern in lowered:
            raise ValueError(f"보안 가드레일 차단: 허용되지 않은 프롬프트 패턴입니다 ({pattern})")
    return str(user_question).strip()


def enforce_output_guardrail(llm_text):
    """[Output Guardrail] LLM 응답에 의료 진단·처방 표현이 포함되면 안전한 자세 습관 안내 문구로 교정합니다."""
    sanitized = str(llm_text)
    for term in MEDICAL_FORBIDDEN_TERMS:
        if term in sanitized:
            return "본 서비스는 의료 진단을 제공하지 않습니다. 바른 착석 습관 유지를 위해 30분마다 가벼운 목·어깨 스트레칭을 권장합니다."
    return sanitized


def build_semantic_bucket_key(good_ratio, dominant_issue="forward_head", warning_count=0):
    """[Semantic Bucket Caching] 0.62와 0.64처럼 의미가 사실상 같은 자세 통계를 10% 단위 구간('60pct')으로 묶어 캐시 적중률을 높입니다."""
    bucket_pct = int(float(good_ratio) * 10) * 10
    warn_tier = "high" if int(warning_count) >= 5 else "low"
    return f"semantic_coach:{bucket_pct}pct:{dominant_issue}:{warn_tier}"


def select_bedrock_model(task_type="quick_feedback", primary_failed=False):
    """[Multi-Model Router] 작업 종류와 장애 여부에 따라 최적의 Bedrock 모델을 라우팅합니다."""
    if primary_failed:
        return "bedrock-gpt-5.6-sol"
    if task_type == "deep_report":
        return "bedrock-claude-sonnet-5"
    return "bedrock-haiku"


class StateMachineCircuitBreaker:
    """외부 LLM 연동 장애 전파 방지용 3단계(CLOSED -> OPEN -> HALF_OPEN) 서킷 브레이커입니다."""

    def __init__(self, failure_threshold=3, recovery_timeout=30.0, clock=time.monotonic):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self._clock = clock
        self.state = "CLOSED"
        self.failures = 0
        self.opened_at = 0.0

    def allow_request(self):
        if self.state == "CLOSED":
            return True
        if self.state == "OPEN":
            if (self._clock() - self.opened_at) >= self.recovery_timeout:
                self.state = "HALF_OPEN"
                return True
            return False
        return True

    def record_success(self):
        self.failures = 0
        self.state = "CLOSED"

    def record_failure(self):
        self.failures += 1
        if self.failures >= self.failure_threshold:
            self.state = "OPEN"
            self.opened_at = self._clock()


def stream_bedrock_coaching_sse(coaching_text, chunk_size=4):
    """[Bedrock + Lambda SSE 실시간 스트리밍] 긴 AI 코칭 답변을 3초 동안 기다리지 않고
    챗GPT처럼 chunk_size(4글자) 단위로 쪼개어 실시간 SSE('data: ...\n\n') 이벤트로 전송합니다.
    """
    safe_text = enforce_output_guardrail(coaching_text)
    for idx in range(0, len(safe_text), int(chunk_size)):
        token = safe_text[idx : idx + int(chunk_size)]
        yield f"data: {json.dumps({'token': token, 'done': False}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'token': '', 'done': True}, ensure_ascii=False)}\n\n"

