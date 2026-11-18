import json
import time

from .errors import ApiError

# 조회와 증가를 따로 하면 race condition이 생기니까, lua로 묶어서 원자적으로 처리한다.
RATE_LIMIT_LUA_SCRIPT = """
local current = redis.call('INCR', KEYS[1])
if current == 1 then
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
if current > tonumber(ARGV[1]) then
    return 0
end
return 1
"""


class InMemoryRedisStub:
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

    # 비어있으면 내가 먼저 들어감(True), 혹시 죽어도 시간 지나면 자동으로 풀림.
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

    # redis의 eval명령을 인메모리에서 똑같이 재현.
    def eval(self, script, numkeys, *keys_and_args):
        key = keys_and_args[0]
        limit = int(keys_and_args[1])
        window_seconds = float(keys_and_args[2])
        current = self._purge_expired(key)
        if current is None:
            count = 1
            expires_at = self._clock() + window_seconds
        else:
            count = int(current) + 1
            _, expires_at = self._data[key]
        self._data[key] = (str(count), expires_at)
        return 0 if count > limit else 1


class RedisCoordinator:

    def __init__(self, client=None):
        self._client = client if client is not None else InMemoryRedisStub()
    # 다중 서버: 2개의 서버에 같은 취소 요청이 들어올 때, 먼저 들어온 요청만 true를 받고, 2등은 false를 받는다.
    def acquire_idempotency_lock(self, owner, idem_key, ttl_seconds=10):
        lock_key = f"idem_lock:{owner}:{idem_key}"
        return bool(self._client.set(lock_key, "1", nx=True, ex=ttl_seconds))

    def release_idempotency_lock(self, owner, idem_key):
        lock_key = f"idem_lock:{owner}:{idem_key}"
        self._client.delete(lock_key)

    # get으로 명령을 읽고, incr로 올리는 방식은 두 명령사이에 동시 요청이 끼어드는 경쟁조건이 생겨
    # 요청 한도(60회)를 넘길 수 있다. INCR → EXPIRE(60s) → 한도 초과 여부 판단을 하나의 Lua 스크립트로 묶어 
    # EVAL로 Redis에서 원자적(Atomic)으로 실행하고 반환값이 0이면, 429에러를 던집니다.
    def enforce_rate_limit(self, subject, limit=60, window_seconds=60):
        rate_key = f"rate_limit:{subject}"
        allowed = self._client.eval(RATE_LIMIT_LUA_SCRIPT, 1, rate_key, int(limit), int(window_seconds))
        if not allowed:
            raise ApiError(429, "rate_limit_exceeded", "요청이 너무 많습니다. 잠시후 다시 시도해 주세요.")
        return True

    # 실시간 통계 캐싱 (Cache-Aside) 및 데이터 변경 시 즉시 삭제 (Write-Invalidation)
    def _stats_cache_key(self, owner, query_key="default"):
        return f"stats_cache:{owner}:{query_key}"

    def get_cached_statistics(self, owner, query_key="default"):
        cache_key = self._stats_cache_key(owner, query_key)
        try:
            raw = self._client.get(cache_key)
        except Exception:
            return None
        if raw is None:
            return None
        return json.loads(raw)

    # Redis 컨테이너가 죽었을 때 서비스 전체가 500 에러로 뻗지 않도록
    # try ... except Exception으로 감싸서 조용히 무시하고 원본 DB로 우회(Circuit Fallback)하게 만듭니다.
    def set_cached_statistics(self, owner, payload, query_key="default", ttl_seconds=5):
        cache_key = self._stats_cache_key(owner, query_key)
        try:
            self._client.set(cache_key, json.dumps(payload, separators=(",", ":"), sort_keys=True), ex=ttl_seconds)
        except Exception:
            return False
        return True

    def invalidate_statistics(self, owner, query_key="default"):
        cache_key = self._stats_cache_key(owner, query_key)
        try:
            self._client.delete(cache_key)
        except Exception:
            return False
        return True

        

