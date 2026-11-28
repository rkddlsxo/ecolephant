"""
- RDS(PostgreSQL) vs DynamoDB 역할 분리:
  1) 정형 데이터(측정 세션, 5초 샘플, 1분 타임라인 통계) -> RDS(PostgreSQL)
  2) 비정형·가변 길이 데이터(AI 자세 코치 챗봇의 사용자별 멀티턴 질문/답변 대화 히스토리) -> DynamoDB (pk=CHAT#{owner}, sk=TURN#{seq})
"""
import time


def evaluate_pomodoro_challenge(good_ratio, duration_minutes=25, prev_streak=0):
    """25분 이상 측정하고 바른 자세 비율(good_ratio)이 80%(0.8) 이상이면 챌린지 성공(streak + 1) 및 S/A/B/C 등급을 부여합니다."""
    ratio = float(good_ratio)
    passed = duration_minutes >= 25 and ratio >= 0.80
    new_streak = (int(prev_streak) + 1) if passed else 0

    if ratio >= 0.90:
        grade = "S"
    elif ratio >= 0.80:
        grade = "A"
    elif ratio >= 0.65:
        grade = "B"
    else:
        grade = "C"

    return {
        "passed": passed,
        "grade": grade,
        "good_ratio": round(ratio, 4),
        "duration_minutes": int(duration_minutes),
        "streak_days": new_streak,
    }


class DynamoChatHistoryStore:
    """DynamoDB 단일 테이블 키 구조(pk='CHAT#<owner>', sk='TURN#<seq>')로 AI 자세 코치 챗봇 대화 맥락을 저장·조회합니다."""

    def __init__(self):
        self._items = {}

    def append_turn(self, owner, role, message, ttl_days=7, now_fn=time.time):
        if role not in {"user", "assistant"}:
            raise ValueError(f"허용되지 않은 대화 역할입니다: {role}")
        pk = f"CHAT#{owner}"
        turns = self._items.setdefault(pk, [])
        seq = len(turns) + 1
        # 하루는 86400초 인데, 현재 시각에 7일을 더 한 초 단위 숫자를 expires_at칸에 넣어두면, 7일 뒤에 삭제 쿼리를 안 날려도 aws dynamodb가 백그라운드에서 무료로 자동 소각 해줌.
        expires_at = int(now_fn()) + (int(ttl_days) * 86400)
        item = {"pk": pk, "sk": f"TURN#{seq:04d}", "role": role, "message": str(message), "expires_at": expires_at}
        turns.append(item)
        return item

    def recent_turns(self, owner, limit=6):
        pk = f"CHAT#{owner}"
        turns = self._items.get(pk, [])
        return list(turns[-int(limit) :])

