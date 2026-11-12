"""Initialize the local PostgreSQL schema; refuses remote hosts unless explicitly allowed."""
import os
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

ALLOWED_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "postgres"}

#dsn은 db접속 주소
#만약 개발자가 실수로 내 컴퓨터 환경변수에 실제 서비스 중인 aws 운영 DB주소를 넣어둔 채로 이 로컬 초기화 스크립트를 돌리면 큰일난다.
#그래서 parsed.hostname이 내 컴퓨터(localhost, 127.0.0.1)나 도커 내부(postgres)가 아니면 SystemExit으로 즉시 프로그램을 강제 종료시켜서 운영 DB를 보호한다.
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

#검사를 통과하면 DB에 접속해서 우리가 만든 sql을 실행해 테이블 5개를 만든다.
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(sql)
    print("PostgreSQL schema initialized")


if __name__ == "__main__":
    main()

