"""Day 5 단위 테스트: 다중 WAS(replicas: 2) 환경 Redis SET NX EX 선점 락 및 compose.redis.yml 메모리 보호 검증."""
from pathlib import Path
import unittest

from backend.ecolephant.errors import ApiError
from backend.ecolephant.redis_store import InMemoryRedisStub, RATE_LIMIT_LUA_SCRIPT, RedisCoordinator

ROOT = Path(__file__).resolve().parents[2]


class FakeClock:
    def __init__(self, now=100.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class RedisDay5IdempotencyLockTest(unittest.TestCase):
    def test_compose_redis_enforces_local_bind_maxmemory_and_lru_policy(self):
        """[Day 5 인프라 검증] compose.redis.yml은 외부 노출 차단(127.0.0.1:6379) 및 OOM 방지(128mb + allkeys-lru)를 강제해야 합니다."""
        compose_text = (ROOT / "compose.redis.yml").read_text(encoding="utf-8")
        self.assertIn("redis:7-alpine", compose_text)
        self.assertIn("127.0.0.1:6379:6379", compose_text)
        self.assertIn("128mb", compose_text)
        self.assertIn("allkeys-lru", compose_text)
        self.assertIn("redis-cli", compose_text)

    def test_multi_was_set_nx_ex_allows_first_worker_and_blocks_duplicate_until_ttl(self):
        """[Day 5 동시성 검증] WAS 1번과 WAS 2번이 같은 공용 Redis를 바라볼 때, 먼저 도착한 1등만 True를 받고 2등은 False로 차단되며 TTL 만료 후 자동 해제되어야 합니다."""
        clock = FakeClock()
        shared_redis = InMemoryRedisStub(clock=clock)
        was_worker_1 = RedisCoordinator(client=shared_redis)
        was_worker_2 = RedisCoordinator(client=shared_redis)

        # 허용 케이스: 1번 백엔드가 먼저 도착해 락 선점 성공 (True)
        self.assertTrue(was_worker_1.acquire_idempotency_lock("user-1", "idem-abc", ttl_seconds=10))

        # 거부 케이스: 0.001초 뒤 2번 백엔드에 똑같은 idem-abc가 들어오면 NX에 의해 즉시 차단 (False)
        self.assertFalse(was_worker_2.acquire_idempotency_lock("user-1", "idem-abc", ttl_seconds=10))

        # 다른 사용자의 요청이나 다른 idem_key는 영향받지 않고 정상 통과 (Blast Radius 격리)
        self.assertTrue(was_worker_2.acquire_idempotency_lock("user-2", "idem-abc", ttl_seconds=10))

        # Q1 시나리오 검증: 만약 1번 백엔드가 에러로 죽어 release를 못 했더라도, 10초(TTL)가 지나면 자동 삭제되어 영구 먹통(Deadlock)이 풀려야 합니다!
        clock.advance(10.1)
        self.assertTrue(was_worker_2.acquire_idempotency_lock("user-1", "idem-abc", ttl_seconds=10))

    def test_lua_rate_limiter_allows_within_limit_and_raises_429_on_burst(self):
        """[Day 6 검증] Lua 스크립트 기반 Rate Limiter는 한도(limit) 내 요청은 통과시키고, 초과 요청은 429 rate_limit_exceeded로 즉시 차단하며 윈도우 만료 후 복구되어야 합니다."""
        self.assertIn("redis.call('INCR', KEYS[1])", RATE_LIMIT_LUA_SCRIPT)
        self.assertIn("redis.call('EXPIRE', KEYS[1]", RATE_LIMIT_LUA_SCRIPT)

        clock = FakeClock()
        shared_redis = InMemoryRedisStub(clock=clock)
        was_worker_1 = RedisCoordinator(client=shared_redis)
        was_worker_2 = RedisCoordinator(client=shared_redis)

        # 허용 케이스: 1번·2번 WAS로 번갈아 들어온 3번의 요청(limit=3)은 모두 통과
        self.assertTrue(was_worker_1.enforce_rate_limit("user-burst", limit=3, window_seconds=60))
        self.assertTrue(was_worker_2.enforce_rate_limit("user-burst", limit=3, window_seconds=60))
        self.assertTrue(was_worker_1.enforce_rate_limit("user-burst", limit=3, window_seconds=60))

        # 거부 케이스 (Negative Test): 4번째 요청이 들어오면 429 Too Many Requests(rate_limit_exceeded)로 차단!
        with self.assertRaises(ApiError) as ctx:
            was_worker_2.enforce_rate_limit("user-burst", limit=3, window_seconds=60)
        self.assertEqual(ctx.exception.status, 429)
        self.assertEqual(ctx.exception.code, "rate_limit_exceeded")

        # 다른 사용자는 영향받지 않고 정상 통과
        self.assertTrue(was_worker_1.enforce_rate_limit("other-user", limit=3, window_seconds=60))

        # 60초 윈도우가 지나면 카운터가 초기화되어 다시 요청이 통과되어야 합니다!
        clock.advance(60.1)
        self.assertTrue(was_worker_1.enforce_rate_limit("user-burst", limit=3, window_seconds=60))


if __name__ == "__main__":
    unittest.main()
