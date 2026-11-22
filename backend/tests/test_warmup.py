"""Day 12 단위 테스트: 무중단 배포 초기 Cold Start 방지용 DB 커넥션 풀 사전 예열(Warm-up) 및 Deep Healthcheck 검증."""
import unittest

from backend.ecolephant.postgres import PostgresRepository
from backend.ecolephant.redis_store import RedisCoordinator
from backend.ecolephant.warmup import warmup_and_check_readiness


class FakeConn:
    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


class Day12WarmupAndDeepHealthcheckTest(unittest.TestCase):
    def test_warmup_prepopulates_db_connection_pool_and_reports_ready(self):
        """[Day 12 Warm-up 검증] 컨테이너 기동 직후 warmup_and_check_readiness를 실행하면 첫 손님이 오기 전에 이미 커넥션 풀(_pool)에 1개의 연결이 채워져 있어야 합니다."""
        opened = []

        def open_conn(_dsn):
            conn = FakeConn()
            opened.append(conn)
            return conn

        repo = PostgresRepository("postgresql://localhost/ecolephant", connect_fn=open_conn, pool_size=8)
        # Warm-up 전에는 커넥션 풀이 비어 있음 (0개)
        self.assertEqual(len(repo._pool), 0)

        status = warmup_and_check_readiness(repository=repo, redis_coord=RedisCoordinator())
        self.assertTrue(status["ready"])
        self.assertEqual(status["db"], "ok")
        self.assertEqual(status["cache"], "ok")
        # Warm-up 직후에는 첫 손님이 오기 전인데도 이미 풀에 따끈따끈한 연결 1개가 예열되어 들어있어야 합니다!
        self.assertEqual(len(opened), 1)
        self.assertEqual(len(repo._pool), 1)

    def test_deep_healthcheck_reports_not_ready_when_db_is_unreachable(self):
        """[Day 12 Deep Healthcheck 거부 검증] DB 연결이 불가능한 반쪽짜리 컨테이너는 ready=False(db='unavailable')를 반환해 트래픽 유입을 막아야 합니다."""

        def broken_conn(_dsn):
            raise ConnectionError("PostgreSQL unreachable")

        repo = PostgresRepository("postgresql://localhost/ecolephant", connect_fn=broken_conn, pool_size=8)
        status = warmup_and_check_readiness(repository=repo)
        self.assertFalse(status["ready"])
        self.assertEqual(status["db"], "unavailable")


if __name__ == "__main__":
    unittest.main()
