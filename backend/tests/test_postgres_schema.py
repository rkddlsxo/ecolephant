import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
COMPOSE_POSTGRES = ROOT / "compose.postgres.yml"
SCHEMA_SQL = ROOT / "backend/ecolephant/sql/schema.sql"
INIT_POSTGRES = ROOT / "scripts/init-postgres.py"


def load_init_module():
    spec = importlib.util.spec_from_file_location("init_postgres", INIT_POSTGRES)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PostgresDay1SchemaTest(unittest.TestCase):
    def test_compose_postgres_enforces_local_bind_and_healthy_startup_order(self):
        content = COMPOSE_POSTGRES.read_text(encoding="utf-8")
        # 1) 외부 노출 방지를 위해 127.0.0.1 로컬 바인딩을 강제해야 합니다.
        self.assertIn('"127.0.0.1:5432:5432"', content)
        # 2) DB가 쿼리를 받을 준비가 끝났는지 pg_isready로 검사해야 합니다.
        self.assertIn("pg_isready", content)
        # 3) 초기화 컨테이너는 반드시 DB가 healthy 상태가 된 뒤에 실행되어야 합니다.
        self.assertIn("condition: service_healthy", content)

    def test_schema_sql_extracts_normalized_columns_and_uses_jsonb(self):
        sql = SCHEMA_SQL.read_text(encoding="utf-8")
        for table in ("sessions", "samples", "events", "timeline_buckets", "policies"):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", sql)
        # Q1에서 확인한 핵심 정규화 라벨 컬럼들이 sessions 테이블에 분리되어 있어야 합니다.
        for column in (
            "status TEXT NOT NULL",
            "requested_mode TEXT NOT NULL",
            "policy_id TEXT NOT NULL",
            "data_source TEXT NOT NULL",
            "started_at TIMESTAMPTZ NOT NULL",
            "ended_at TIMESTAMPTZ",
            "body JSONB NOT NULL",
            "revision INTEGER NOT NULL",
            "deleted BOOLEAN NOT NULL",
        ):
            self.assertIn(column, sql)
        self.assertIn("UNIQUE (owner, client_id)", sql)
        self.assertIn("UNIQUE (owner, idem_key)", sql)

    def test_init_postgres_blocks_remote_hosts_by_default(self):
        module = load_init_module()
        # 허용 케이스: 로컬 및 도커 내부 postgres 호스트는 통과해야 합니다.
        self.assertEqual(
            module.validate_local_dsn("postgresql://ecolephant:pw@localhost:5432/ecolephant"),
            "postgresql://ecolephant:pw@localhost:5432/ecolephant",
        )
        self.assertEqual(
            module.validate_local_dsn("postgresql://ecolephant:pw@postgres:5432/ecolephant"),
            "postgresql://ecolephant:pw@postgres:5432/ecolephant",
        )
        # 거부 케이스: 원격(AWS RDS 등) 엔드포인트는 기본값에서 즉시 차단(SystemExit)해야 합니다.
        with self.assertRaises(SystemExit):
            module.validate_local_dsn("postgresql://admin:pw@prod-db.ap-northeast-2.rds.amazonaws.com:5432/ecolephant")


if __name__ == "__main__":
    unittest.main()

