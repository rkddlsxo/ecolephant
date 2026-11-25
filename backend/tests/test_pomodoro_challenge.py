"""[5일 플랜 — Day 2 단위 테스트] 25분 뽀모도로 바른 자세 챌린지(Streak·등급) 및 DynamoDB AI 코치 챗봇 히스토리 검증."""
import unittest

from backend.ecolephant.pomodoro_challenge import DynamoChatHistoryStore, evaluate_pomodoro_challenge


class Day2PomodoroAndDynamoChatTest(unittest.TestCase):
    def test_pomodoro_challenge_increments_streak_on_80_percent_and_resets_on_failure(self):
        # 허용 케이스: 25분 측정 + 바른 자세 85% -> 통과(passed=True), 등급 A, 연속 달성 3일 -> 4일 증가
        success = evaluate_pomodoro_challenge(good_ratio=0.85, duration_minutes=25, prev_streak=3)
        self.assertTrue(success["passed"])
        self.assertEqual(success["grade"], "A")
        self.assertEqual(success["streak_days"], 4)

        # 미달 케이스: 바른 자세 60% -> 실패(passed=False), 등급 C, 스트릭 0 초기화
        fail = evaluate_pomodoro_challenge(good_ratio=0.60, duration_minutes=25, prev_streak=4)
        self.assertFalse(fail["passed"])
        self.assertEqual(fail["grade"], "C")
        self.assertEqual(fail["streak_days"], 0)

    def test_dynamodb_chat_history_preserves_multiturn_order_and_blocks_invalid_role(self):
        store = DynamoChatHistoryStore()
        store.append_turn("user-1", "user", "오늘 거북목 경고가 왜 많이 떴어?")
        store.append_turn("user-1", "assistant", "15분~20분 구간에 앞쏠림이 4회 집중되었습니다.")
        history = store.recent_turns("user-1")
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["pk"], "CHAT#user-1")
        self.assertEqual(history[1]["sk"], "TURN#0002")

        # 거부 케이스 (Negative Test): user/assistant 외의 잘못된 role 입력 시 ValueError 차단
        with self.assertRaises(ValueError):
            store.append_turn("user-1", "hacker", "invalid role")


if __name__ == "__main__":
    unittest.main()
