"""Transactional Outbox 원자성(Dual Write 방어) 및 SQS/SNS 릴레이 멱등성 검증."""
import unittest

from backend.ecolephant.transactional_outbox import TransactionalOutboxStore


class Day3TransactionalOutboxTest(unittest.TestCase):
    def test_outbox_guarantees_atomicity_and_relays_pending_events_exactly_once(self):
        store = TransactionalOutboxStore()

        # 거부/롤백 케이스: DB 트랜잭션 에러가 나면 세션과 아웃박스 이벤트 둘 다 저장되지 않아야 합니다(원자성 보장!)
        with self.assertRaises(RuntimeError):
            store.complete_session_with_outbox("user-1", "sess-fail", {"good_ratio": 0.5}, simulate_db_error=True)
        self.assertNotIn("sess-fail", store.sessions)
        self.assertEqual(len(store.outbox_events), 0)

        # 허용 케이스: 정상 완료 시 세션과 PENDING 아웃박스 이벤트가 함께 저장됩니다.
        event_id = store.complete_session_with_outbox("user-1", "sess-ok", {"good_ratio": 0.88})
        self.assertEqual(event_id, "outbox-1")
        self.assertEqual(store.outbox_events[0]["status"], "PENDING")

        # 릴레이 워커 실행: SQS와 SNS로 각각 1건씩 전송되고 상태가 PUBLISHED로 바뀌어야 합니다.
        sqs_sent, sns_sent = [], []
        relayed = store.relay_pending_events(
            sqs_publish_fn=lambda ev: sqs_sent.append(ev["event_id"]),
            sns_notify_fn=lambda ev: sns_sent.append(ev["event_id"]),
        )
        self.assertEqual(relayed, 1)
        self.assertEqual(sqs_sent, ["outbox-1"])
        self.assertEqual(sns_sent, ["outbox-1"])
        self.assertEqual(store.outbox_events[0]["status"], "PUBLISHED")

        # 재실행 멱등성(Idempotency) 검증: 이미 PUBLISHED된 이벤트는 두 번째 릴레이 실행 시 중복 발송(0건)되지 않아야 합니다!
        relayed_again = store.relay_pending_events(
            sqs_publish_fn=lambda ev: sqs_sent.append(ev["event_id"]),
            sns_notify_fn=lambda ev: sns_sent.append(ev["event_id"]),
        )
        self.assertEqual(relayed_again, 0)
        self.assertEqual(len(sqs_sent), 1)


if __name__ == "__main__":
    unittest.main()
