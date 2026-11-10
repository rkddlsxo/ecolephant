"""Initialize the local PostgreSQL schema; refuses remote hosts unless explicitly allowed."""
import os
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

ALLOWED_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "postgres"}


def validate_local_dsn(dsn: str, allow_remote: bool = False) -> str:
    """실수로 운영(AWS) DB에 로컬 초기화 스크립트를 실행하는 사고(Blast Radius)를 방어합니다."""
    parsed = urlparse(dsn)
    if parsed.scheme not in {"postgresql", "postgres"}:
        raise ValueError("PostgreSQL DSN must start with postgresql:// or postgres://")
    if not allow_remote and parsed.hostname not in ALLOWED_LOCAL_HOSTS:
        raise SystemExit("This initializer only supports local PostgreSQL hosts")
    return dsn


def load_schema_sql(schema_path: Path | None = None) -> str:
    if schema_path is None:
        docker_path = Path("/tools/schema.sql")
        default_path = Path(__file__).resolve().parents[1] / "backend/ecolephant/sql/schema.sql"
        schema_path = docker_path if docker_path.exists() else default_path
    return schema_path.read_text(encoding="utf-8")


def main() -> None:
    load_dotenv(Path(__file__).resolve().parents[1] / "backend/.env")
    dsn = os.getenv(
        "ECOLEPHANT_POSTGRES_DSN",
        "postgresql://ecolephant:ecolephant_local@localhost:5432/ecolephant",
    )
    allow_remote = os.getenv("ECOLEPHANT_ALLOW_REMOTE_INIT", "").lower() == "true"
    validate_local_dsn(dsn, allow_remote=allow_remote)
    sql = load_schema_sql()
    import psycopg

    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
    print("PostgreSQL schema initialized")


if __name__ == "__main__":
    main()

