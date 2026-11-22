"""RabbitMQ Producer - 클라이언트가 전송한 자세 측정 데이터를 메시지 큐에 발행(publish)하는 모듈"""
from collections import deque
import json


# 가짜 브로커 (RabbitMQ 흉내)
class InMemoryBrokerQueue:

    def __init__(self, prefetch_count=1):
        self.prefetch_count = prefetch_count  # ACK 없이 동시에 줄 수 있는 최대 개수
        self._ready = deque()                 # 대기 중인 메시지 (FIFO)
        self._unacked = {}                    # 꺼내갔지만 ACK 안 된 메시지 {번호: 메시지}
        self._next_tag = 1                    # 메시지 번호 (1씩 증가)

    # 넣기: 대기 줄 맨 뒤에 추가
    def publish(self, queue_name, body, persistent=True):
        self._ready.append({"queue": queue_name, "body": body, "persistent": bool(persistent)})
        return True

    def pending_count(self):
        return len(self._ready)    # 대기 개수

    def unacked_count(self):
        return len(self._unacked)  # 처리 중 개수

    # 꺼내기: Ready → Unacked로 옮기고 번호 붙여서 반환
    def consume_one(self):
        # 처리 중인 게 꽉 찼거나, 대기 메시지가 없으면 못 꺼냄
        if len(self._unacked) >= self.prefetch_count or not self._ready:
            return None
        msg = self._ready.popleft()
        tag = self._next_tag
        self._next_tag += 1
        self._unacked[tag] = msg
        return tag, msg["body"]

    # ACK: 성공 → 완전히 삭제
    def basic_ack(self, delivery_tag):
        self._unacked.pop(delivery_tag, None)

    # NACK: 실패 → 대기 줄 맨 앞으로 되돌림 (재시도)
    def basic_nack(self, delivery_tag, requeue=True):
        msg = self._unacked.pop(delivery_tag, None)
        if msg is not None and requeue:
            self._ready.appendleft(msg)


class BatchQueueCoordinator:

    QUEUE_NAME = "ecolephant.samples.batch"

    def __init__(self, broker=None, fallback_fn=None):
        self.broker = broker if broker is not None else InMemoryBrokerQueue(prefetch_count=1)  # 없으면 기본 브로커
        self.fallback_fn = fallback_fn  # 브로커 고장 시 대신 실행할 함수

    # Producer: JSON으로 바꿔서 큐에 넣기
    def enqueue_batch(self, owner, session_id, samples):
        envelope = json.dumps(
            {"owner": owner, "session_id": session_id, "samples": list(samples)},
            separators=(",", ":"),
        )
        try:
            self.broker.publish(self.QUEUE_NAME, envelope, persistent=True)
            return "queued"                                   # 정상: 큐에 넣고 바로 반환
        except Exception:
            if self.fallback_fn is not None:
                self.fallback_fn(owner, session_id, samples)
                return "fallback_direct"                      # 고장: DB에 직접 저장
            raise                                             # fallback도 없으면 에러 전달

    # Consumer: 1개 꺼내서 처리 → 성공 ACK / 실패 NACK
    def process_next(self, processor_fn):
        item = self.broker.consume_one()
        if item is None:
            return False
        delivery_tag, raw_body = item
        payload = json.loads(raw_body)
        try:
            processor_fn(payload)
            self.broker.basic_ack(delivery_tag)
            return True
        except Exception:
            self.broker.basic_nack(delivery_tag, requeue=True)
            raise