"""RabbitMQ Producer - 클라이언트가 전송한 자세 측정 데이터를 메시지 큐에 발행(publish)하는 모듈"""
from collections import deque
import json


class InMemoryBrokerQueue:

    def __init__(self, prefetch_count=1):
        # QoS prefetch: consumer가 ack 없이 동시에 받을 수 있는 최대 메시지 수 (basic.qos)
        self.prefetch_count = prefetch_count
        # Ready 상태 메시지 버퍼 (FIFO). deque는 양끝 삽입/삭제가 O(1)
        self._ready = deque()
        # Unacked 메시지: consumer에게 전달됐지만 아직 ack를 받지 못한 메시지 {delivery_tag: message}
        self._unacked = {}
        # delivery tag: 채널 내 메시지 식별자. ack/nack 시 사용 (단조 증가)
        self._next_tag = 1

    # 메시지 발행 (basic.publish)
    # persistent=True → delivery_mode=2: 브로커 재시작 시에도 유실되지 않도록 디스크에 기록
    #                   (실제 RabbitMQ에서는 큐도 durable=True로 선언해야 유지됨)
    def publish(self, queue_name, body, persistent=True):
        # Ready 큐 tail에 enqueue
        self._ready.append({"queue": queue_name, "body": body, "persistent": bool(persistent)})
        return True

    # Queue depth (backlog): 아직 consume되지 않은 메시지 수 → 모니터링/스케일링 지표
    def pending_count(self):
        return len(self._ready)

    def unacked_count(self):
        return len(self._unacked)

    # [Day 10] 우체통에서 편지 1통 꺼내기 (Prefetch=1 제한: 앞 편지 완료 도장을 찍기 전엔 새 편지를 안 줌)
    def consume_one(self):
        if len(self._unacked) >= self.prefetch_count or not self._ready:
            return None
        msg = self._ready.popleft()
        tag = self._next_tag
        self._next_tag += 1
        self._unacked[tag] = msg
        return tag, msg["body"]

    # [Day 10] Manual ACK (수동 완료 도장): DB 저장까지 무사히 끝났을 때만 호출해 우체통에서 완전히 지웁니다.
    def basic_ack(self, delivery_tag):
        self._unacked.pop(delivery_tag, None)

    # [Day 10] Manual NACK (실패 반송): DB 저장 도중 에러가 나면 편지를 버리지 않고 다시 줄 맨 앞(appendleft)으로 돌려놓습니다.
    def basic_nack(self, delivery_tag, requeue=True):
        msg = self._unacked.pop(delivery_tag, None)
        if msg is not None and requeue:
            self._ready.appendleft(msg)


class BatchQueueCoordinator:
    """Producer 측 Facade. 브로커 발행과 장애 시 fallback 경로를 캡슐화한다."""

    # 라우팅 대상 큐 이름 (도메인.리소스.용도 네임스페이스 컨벤션)
    QUEUE_NAME = "ecolephant.samples.batch"

    def __init__(self, broker=None, fallback_fn=None):
        # 의존성 주입(DI): 브로커를 주입받지 않으면 기본 Mock 브로커 사용
        self.broker = broker if broker is not None else InMemoryBrokerQueue(prefetch_count=1)
        # Fallback 핸들러: 브로커 장애 시 DB에 동기식으로 직접 적재 (Graceful degradation)
        self.fallback_fn = fallback_fn

    # 측정 데이터 배치를 메시지로 직렬화해 큐에 발행
    def enqueue_batch(self, owner, session_id, samples):
        # Envelope 패턴: payload(samples) + 메타데이터(owner, session_id)를 하나의 메시지로 직렬화
        # separators=(",", ":") → 공백 제거한 compact JSON으로 페이로드 크기 최소화
        envelope = json.dumps(
            {"owner": owner, "session_id": session_id, "samples": list(samples)},
            separators=(",", ":"),
        )

        # 정상 경로: 비동기 처리 - 큐에 발행만 하고 즉시 반환 (Producer/Consumer decoupling)
        # 장애 경로: 브로커 예외 발생 시 fallback으로 동기 DB 적재
        try:
            self.broker.publish(self.QUEUE_NAME, envelope, persistent=True)
            return "queued"
        except Exception:
            # FIX: fallback_in → fallback_fn (오타 시 AttributeError 발생)
            if self.fallback_fn is not None:
                # FIX: sample → samples (미정의 변수 시 NameError 발생)
                self.fallback_fn(owner, session_id, samples)
                return "fallback_direct"
            # fallback이 없으면 예외를 삼키지 않고 호출자에게 재전파(re-raise)
            raise

    # [Day 10 핵심 함수] 집배원 워커(Consumer): 우체통에서 편지 1통을 꺼내 DB에 저장하고 도장 찍기!
    def process_next(self, processor_fn):
        item = self.broker.consume_one()
        if item is None:
            return False
        delivery_tag, raw_body = item
        payload = json.loads(raw_body)
        # TODO (Day 10):
        # 1. try 블록에서 processor_fn(payload)를 실행하고 성공하면 self.broker.basic_ack(delivery_tag) 완료 도장을 찍은 뒤 True를 반환하세요!
        # 2. except Exception 블록에서는 편지가 날아가지 않게 self.broker.basic_nack(delivery_tag, requeue=True)로 다시 우체통에 돌려놓고 에러를 raise 하세요!
        pass

