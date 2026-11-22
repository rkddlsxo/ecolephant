"""Day 9 단위 테스트: RabbitMQ 컨테이너 설정(compose.rabbitmq.yml) 및 Producer(enqueue_batch) 발행·장애 시 동기 Fallback 검증."""
from pathlib import Path
import unittest

from backend.ecolephant.queue_worker import BatchQueueCoordinator, InMemoryBrokerQueue

ROOT = Path(__file__).resolve().parents[2]


class RabbitMQDay9ProducerTest(unittest.TestCase):
    def test_compose_rabbitmq_enforces_local_bind_memory_watermark_and_healthcheck(self):
        """[Day 9 인프라 검증] compose.rabbitmq.yml은 127.0.0.1 로컬 바인딩, 메모리 워터마크(0.4), ping 헬스체크를 포함해야 합니다."""
        compose_text = (ROOT / "compose.rabbitmq.yml").read_text(encoding="utf-8")
        self.assertIn("rabbitmq:3.13-management-alpine", compose_text)
        self.assertIn("127.0.0.1:5672:5672", compose_text)
        self.assertIn("127.0.0.1:15672:15672", compose_text)
        self.assertIn("RABBITMQ_VM_MEMORY_HIGH_WATERMARK", compose_text)
        self.assertIn("rabbitmq-diagnostics", compose_text)

    def test_producer_enqueues_batch_and_falls_back_to_direct_save_when_broker_is_down(self):
        """[Day 9 Producer 검증] 브로커 정상 시 큐에 적재('queued')하고, 브로커 장애 시 데이터를 잃지 않고 fallback_fn('fallback_direct')으로 저장해야 합니다."""
        broker = InMemoryBrokerQueue(prefetch_count=1)
        coord = BatchQueueCoordinator(broker=broker)

        # 허용 케이스: 정상 우체통(broker)에 측정 샘플 배치를 넣으면 "queued"를 반환하고 대기열이 1이 됩니다.
        status = coord.enqueue_batch("user-1", "sess-1", [{"seq": 1, "duration_ms": 5000}])
        self.assertEqual(status, "queued")
        self.assertEqual(broker.pending_count(), 1)

        # 장애 우회(Fallback) 케이스: RabbitMQ가 죽어서 publish()에서 ConnectionError가 터질 때 fallback_fn이 호출되어야 합니다!
        class BrokenBroker:
            def publish(self, queue_name, body, persistent=True):
                raise ConnectionError("RabbitMQ broker unreachable")

        fallback_saved = []
        fallback_coord = BatchQueueCoordinator(
            broker=BrokenBroker(),
            fallback_fn=lambda owner, sid, samples: fallback_saved.append((owner, sid, list(samples))),
        )
        status_fallback = fallback_coord.enqueue_batch("user-1", "sess-1", [{"seq": 2, "duration_ms": 5000}])
        self.assertEqual(status_fallback, "fallback_direct")
        self.assertEqual(len(fallback_saved), 1)
        self.assertEqual(fallback_saved[0][1], "sess-1")

    def test_consumer_manual_ack_deletes_on_success_and_nack_requeues_on_failure(self):
        """[Day 10 Consumer 검증] 워커가 DB 저장에 실패하면 basic_nack(requeue=True)로 메시지가 다시 대기열에 복구되고, 재시도 성공 시 basic_ack로 완전히 제거되어야 합니다."""
        broker = InMemoryBrokerQueue(prefetch_count=1)
        coord = BatchQueueCoordinator(broker=broker)
        coord.enqueue_batch("user-1", "sess-10", [{"seq": 1, "duration_ms": 5000}])
        self.assertEqual(broker.pending_count(), 1)

        # 거부/장애 케이스: 워커가 메시지를 꺼내 DB에 저장하는 도중 RuntimeError가 발생하면?
        # 메시지가 증발하지 않고 basic_nack(requeue=True)에 의해 다시 대기열(pending_count=1, unacked_count=0)로 돌아와야 합니다!
        def failing_db_writer(_payload):
            raise RuntimeError("DB connection lost during batch write")

        with self.assertRaises(RuntimeError):
            coord.process_next(failing_db_writer)

        self.assertEqual(broker.unacked_count(), 0)
        self.assertEqual(broker.pending_count(), 1)

        # 허용 케이스: DB가 복구된 뒤 다음 워커가 다시 꺼내서 성공하면 basic_ack가 호출되어 대기열이 0이 됩니다!
        processed = []
        self.assertTrue(coord.process_next(lambda payload: processed.append(payload)))
        self.assertEqual(len(processed), 1)
        self.assertEqual(processed[0]["session_id"], "sess-10")
        self.assertEqual(broker.pending_count(), 0)
        self.assertEqual(broker.unacked_count(), 0)

    def test_dlq_isolates_poison_message_after_max_retries_and_replays_zero_loss(self):
        """[Day 11 DLQ 검증] max_retries(3회) 연속 실패한 메시지는 앞길을 막지 않도록 DLQ로 격리되고, DB 복구 후 replay_dead_letters()로 무손실 재처리되어야 합니다."""
        broker = InMemoryBrokerQueue(prefetch_count=1, max_retries=3)
        coord = BatchQueueCoordinator(broker=broker)
        coord.enqueue_batch("user-1", "sess-dlq", [{"seq": 1, "duration_ms": 5000}])

        def always_fail(_payload):
            raise RuntimeError("DB temporarily restarting")

        # 1번째, 2번째 실패까지는 아직 max_retries(3) 미만이므로 원래 대기열(pending_count=1, dlq_count=0)로 돌아옵니다.
        for _ in range(2):
            with self.assertRaises(RuntimeError):
                coord.process_next(always_fail)
            self.assertEqual(broker.pending_count(), 1)
            self.assertEqual(broker.dlq_count(), 0)

        # 3번째 실패(attempts == 3 == max_retries) 시에는 더 이상 줄 맨 앞을 막지 않도록 비상 보관함(DLQ)으로 격리됩니다!
        with self.assertRaises(RuntimeError):
            coord.process_next(always_fail)
        self.assertEqual(broker.pending_count(), 0)
        self.assertEqual(broker.dlq_count(), 1)

        # DB가 정상 복구된 뒤 replay_dead_letters()를 호출하면 DLQ에서 다시 대기열로 1건이 복구되고 정상 처리됩니다!
        replayed = coord.replay_dead_letters()
        self.assertEqual(replayed, 1)
        self.assertEqual(broker.dlq_count(), 0)
        self.assertEqual(broker.pending_count(), 1)

        recovered = []
        self.assertTrue(coord.process_next(lambda payload: recovered.append(payload)))
        self.assertEqual(len(recovered), 1)
        self.assertEqual(recovered[0]["session_id"], "sess-dlq")


if __name__ == "__main__":
    unittest.main()
