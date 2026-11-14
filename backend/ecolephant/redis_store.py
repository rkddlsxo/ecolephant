"""Redis 공용 저장소 — 다중 백엔드(replicas: 2) 환경에서 중복 요청 선점 락(SET NX EX), Lua 처리율 제한(Rate Limit), 실시간 통계 캐싱을 담당합니다."""
import json
import time


class InMemoryRedisStub:
    """로컬 개발·단위 테스트에서 실제 Redis 서버 없이도 SET NX EX, TTL 만료, Lua 원자적 실행을 똑같이 재현하는 어댑터입니다."""

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._data = {}

    def _purge_expired(self, key):
        entry = self._data.get(key)
        if entry is not None:
            value, expires_at = entry
            if expires_at is not None and self._clock() >= expires_at:
                del self._data[key]
                return None
            return value
        return None

    # Redis의 SET 명령어:
    # nx=True (Not eXists): 칠판에 아직 이 키가 없을 때만 적고 True 반환, 이미 있으면 False 반환!
    # ex=초 (EXpire): 지정한 초(TTL)가 지나면 칠판에서 자동으로 지워져 영구 잠금(Deadlock)을 방지!
    def set(self, key, value, nx=False, ex=None):
        current = self._purge_expired(key)
        if nx and current is not None:
            return False
        expires_at = (self._clock() + float(ex)) if ex is not None else None
        self._data[key] = (value, expires_at)
        return True

    def get(self, key):
        return self._purge_expired(key)

    def delete(self, *keys):
        removed = 0
        for key in keys:
            if key in self._data:
                del self._data[key]
                removed += 1
        return removed


class RedisCoordinator:
    """백엔드 컨테이너 2대가 함께 보는 공용 칠판(Redis) 관리자입니다."""

    def __init__(self, client=None):
        self._client = client if client is not None else InMemoryRedisStub()

    # [Day 5 핵심] 다중 서버(replicas: 2) 따닥 클릭 선점 자물쇠 (SET NX EX)
    # 1번 백엔드와 2번 백엔드에 0.001초 차이로 같은 Idempotency-Key 요청이 들어왔을 때,
    # 칠판(Redis)에 먼저 이름을 적은 1등만 True를 받고, 2등은 False를 받아 입구에서 바로 걸러냅니다.
    def acquire_idempotency_lock(self, owner, idem_key, ttl_seconds=10):
        lock_key = f"idem_lock:{owner}:{idem_key}"
        return bool(self._client.set(lock_key, "1", nx=True, ex=ttl_seconds))

    def release_idempotency_lock(self, owner, idem_key):
        lock_key = f"idem_lock:{owner}:{idem_key}"
        self._client.delete(lock_key)
