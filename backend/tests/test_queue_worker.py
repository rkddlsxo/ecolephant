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


if __name__ == "__main__":
    unittest.main()
