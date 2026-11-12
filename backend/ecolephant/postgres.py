"""PostgreSQL repository with MVCC row-level locking, REPEATABLE READ snapshots, and optimistic locking."""
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
import json

from .contracts import canonical
from .errors import ApiError

SCHEMA_PATH = Path(__file__).resolve().parent / "sql/schema.sql"


def _decode_json(value):
    if isinstance(value, (bytes, bytearray)):
        return json.loads(value.decode("utf-8"))
    if isinstance(value, str):
        return json.loads(value)
    return deepcopy(value)


class PostgresRepository:
    def __init__(self, dsn, connect_fn=None, initialize_schema=False):
        self.dsn = dsn
        self._connect_fn = connect_fn
        if initialize_schema:
            with self.connection() as conn:
                conn.execute(SCHEMA_PATH.read_text(encoding="utf-8"))

    def _open_connection(self):
        if self._connect_fn is not None:
            return self._connect_fn(self.dsn)
        import psycopg
        from psycopg.rows import dict_row

        return psycopg.connect(self.dsn, row_factory=dict_row, autocommit=False)

    @contextmanager
    def connection(self, *, repeatable_read=False):
        try:
            conn = self._open_connection()
        except Exception:
            raise ApiError(503, "storage_unavailable", "저장소를 다시 연결해 주세요.") from None
        try:
            # 트랜잭션 격리 수준(Isolation Level)
            # PostgreSQL의 기본값(READ COMMITTED)은 한 트랜잭션 안에서 SELECT를 두 번(sessions 조회 -> samples 조회) 할 때
            # 그 0.001초 사이에 다른 요청이 끼어들어 데이터를 바꾸면 앞뒤가 안 맞는 상태(Non-Repeatable Read)를 읽을 수 있습니다.
            # 여러 테이블을 묶어 읽을 때는 REPEATABLE READ로 격리 수준을 올려 처음 읽은 시점의 일관된 스냅샷을 보장합니다.
            if repeatable_read:
                conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            yield conn
            conn.commit()
        except ApiError:
            conn.rollback()
            raise
        except Exception as exc:
            conn.rollback()
            if exc.__class__.__name__ in {"UniqueViolation", "IntegrityError"}:
                raise ApiError(409, "identity_conflict", "이미 사용된 결과 또는 이벤트 식별자입니다.") from None
            raise ApiError(503, "storage_unavailable", "저장소를 다시 연결해 주세요.") from None
        finally:
            conn.close()

    def ensure_policy(self, policy):
        body = canonical(policy)
        with self.connection() as conn:
            conn.execute(
                "INSERT INTO policies (id, body) VALUES (%s, %s::jsonb) ON CONFLICT (id) DO NOTHING",
                (policy["policy_id"], body),
            )
            row = conn.execute(
                "SELECT body FROM policies WHERE id = %s",
                (policy["policy_id"],),
            ).fetchone()
            if row is None or canonical(_decode_json(row["body"])) != body:
                raise ApiError(409, "policy_id_conflict", "이미 등록된 정책 ID의 내용이 다릅니다.")

    def find_create(self, owner, key, payload, conn=None):
        if conn is None:
            with self.connection() as connection:
                return self.find_create(owner, key, payload, connection)
        matches = conn.execute(
            "SELECT deleted, body FROM sessions WHERE owner = %s AND (client_id = %s OR idem_key = %s)",
            (owner, payload["client_session_id"], key),
        ).fetchall()
        if not matches:
            return None
        decoded = [_decode_json(row["body"]) for row in matches]
        if (
            any(bool(row["deleted"]) or item.get("create") != payload for row, item in zip(matches, decoded))
            or len(matches) > 1
        ):
            raise ApiError(409, "idempotency_conflict", "같은 시작 식별자에 다른 내용이 있습니다.")
        return decoded[0]

    def create(self, owner, key, payload, record):
        session = record["session"]
        with self.connection() as conn:
            existing = self.find_create(owner, key, payload, conn)
            if existing is not None:
                return existing
            # (Race Condition) 방어
            # SQLite처럼 파일 전체를 잠그지 않으므로, 0.001초 차이로 동시에 들어온 두 요청이 모두 위 find_create를 통과할 수 있습니다.
            # 이때 ON CONFLICT DO NOTHING으로 DB UNIQUE 무결성 제약조건에 부딪힌 두 번째 요청이 에러로 죽지 않게 한 뒤,
            # inserted.rowcount == 0 이면 방금 먼저 들어간 첫 번째 요청의 세션을 다시 조회(find_create)해 멱등성을 보장합니다.
            inserted = conn.execute(
                """
                INSERT INTO sessions (
                    id, owner, client_id, idem_key,
                    status, requested_mode, policy_id, data_source, started_at, ended_at,
                    body, revision, deleted
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, 0, FALSE)
                ON CONFLICT DO NOTHING
                """,
                (
                    session["id"],
                    owner,
                    payload["client_session_id"],
                    key,
                    session["status"],
                    session["requested_mode"],
                    session["policy_id"],
                    session.get("data_source", "demo"),
                    session["started_at"],
                    session.get("ended_at"),
                    canonical(record),
                ),
            )
            if inserted.rowcount != 1:
                existing = self.find_create(owner, key, payload, conn)
                if existing is not None:
                    return existing
                raise ApiError(409, "idempotency_conflict", "같은 시작 식별자에 다른 내용이 있습니다.")
            return record

    def _metadata(self, conn, owner, session_id):
        row = conn.execute(
            "SELECT body FROM sessions WHERE id = %s AND owner = %s AND deleted = FALSE",
            (session_id, owner),
        ).fetchone()
        if row is None:
            raise ApiError(404, "not_found", "기록을 찾을 수 없습니다.")
        return _decode_json(row["body"])

    def load_metadata(self, owner, session_id):
        with self.connection() as conn:
            return self._metadata(conn, owner, session_id)

    def load_events(self, owner, session_id):
        with self.connection(repeatable_read=True) as conn:
            record = self._metadata(conn, owner, session_id)
            rows = conn.execute(
                "SELECT seq, body FROM events WHERE session_id = %s ORDER BY seq",
                (session_id,),
            ).fetchall()
            record["events"] = {row["seq"]: _decode_json(row["body"]) for row in rows}
            return record

    def load_timeline_buckets(self, owner, session_id, low, high, revision):
        with self.connection(repeatable_read=True) as conn:
            record = self._metadata(conn, owner, session_id)
            if record["revision"] != revision:
                raise ApiError(409, "concurrent_write", "기록이 변경되었습니다. 다시 시도해 주세요.")
            rows = conn.execute(
                "SELECT body FROM timeline_buckets WHERE session_id = %s AND start_ms >= %s AND start_ms < %s ORDER BY start_ms",
                (session_id, low, high),
            ).fetchall()
            return [_decode_json(row["body"]) for row in rows]

    def load(self, owner, session_id):
        with self.connection(repeatable_read=True) as conn:
            record = self._metadata(conn, owner, session_id)
            sample_rows = conn.execute(
                "SELECT seq, body FROM samples WHERE session_id = %s ORDER BY seq",
                (session_id,),
            ).fetchall()
            event_rows = conn.execute(
                "SELECT seq, body FROM events WHERE session_id = %s ORDER BY seq",
                (session_id,),
            ).fetchall()
            record["samples"] = {row["seq"]: _decode_json(row["body"]) for row in sample_rows}
            record["events"] = {row["seq"]: _decode_json(row["body"]) for row in event_rows}
            return record

    def load_many(self, owner, session_ids):
        """[Day 3 핵심: N+1 쿼리 제거]
        for문 안에서 load()를 N번 부르는 대신, session_ids 리스트를 ANY(%s)로 넘겨
        세션이 100개여도 단 1번의 트랜잭션(쿼리 3번)으로 한꺼번에 묶어 조회합니다.
        """
        if not session_ids:
            return []
        ids = list(session_ids)
        with self.connection(repeatable_read=True) as conn:
            session_rows = conn.execute(
                "SELECT id, body FROM sessions WHERE owner = %s AND deleted = FALSE AND id = ANY(%s)",
                (owner, ids),
            ).fetchall()
            records_by_id = {}
            for row in session_rows:
                rec = _decode_json(row["body"])
                rec["samples"], rec["events"] = {}, {}
                records_by_id[row["id"]] = rec
            if not records_by_id:
                return []
            found_ids = list(records_by_id.keys())
        
            sample_rows = conn.execute(
                "SELECT session_id, seq, body FROM samples WHERE session_id = ANY(%s) ORDER BY seq",
                (found_ids,),
            ).fetchall()
            event_rows = conn.execute(
                "SELECT session_id, seq, body FROM events WHERE session_id = ANY(%s) ORDER BY seq",
                (found_ids,),
            ).fetchall()
            for row in sample_rows:
                records_by_id[row["session_id"]]["samples"][row["seq"]] = _decode_json(row["body"])
            for row in event_rows:
                records_by_id[row["session_id"]]["events"][row["seq"]] = _decode_json(row["body"])
            return [records_by_id[sid] for sid in ids if sid in records_by_id]

    def list(self, owner):
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT body FROM sessions WHERE owner = %s AND deleted = FALSE",
                (owner,),
            ).fetchall()
            return [_decode_json(row["body"])["session"] for row in rows]

    def commit(self, owner, record, samples=(), events=(), timeline_buckets=()):
        session = record["session"]
        session_id, revision = session["id"], record["revision"]
        stored = {k: v for k, v in record.items() if k not in {"samples", "events"}}
        stored["revision"] = revision + 1
        with self.connection() as conn:
            # 낙관적 락(Optimistic Lock — revision 비교)
            # 읽을 때 자물쇠를 걸어 다른 요청을 줄 세우지 않고, 저장(UPDATE)하는 순간에만
            # "내가 처음 읽었던 버전 번호(WHERE revision = %s)가 아직 그대로인가?"를 확인합니다.
            # 만약 그새 다른 요청이 먼저 수정해서 revision이 올라갔다면 updated.rowcount가 0이 되어 409 충돌로 안전하게 막아냅니다.
            updated = conn.execute(
                """
                UPDATE sessions
                SET status = %s,
                    ended_at = %s,
                    body = %s::jsonb,
                    revision = %s
                WHERE id = %s AND owner = %s AND revision = %s AND deleted = FALSE
                """,
                (
                    session["status"],
                    session.get("ended_at"),
                    canonical(stored),
                    revision + 1,
                    session_id,
                    owner,
                    revision,
                ),
            )
            if updated.rowcount != 1:
                raise ApiError(409, "concurrent_write", "기록이 변경되었습니다. 같은 요청을 다시 보내 주세요.")
            for sample in samples:
                conn.execute(
                    """
                    INSERT INTO samples (session_id, seq, elapsed_start_ms, duration_ms, active_mode, body)
                    VALUES (%s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        session_id,
                        sample["seq"],
                        sample["elapsed_start_ms"],
                        sample["duration_ms"],
                        sample["active_mode"],
                        canonical(sample),
                    ),
                )
            for event in events:
                conn.execute(
                    """
                    INSERT INTO events (event_id, session_id, seq, event_type, elapsed_ms, body)
                    VALUES (%s, %s, %s, %s, %s, %s::jsonb)
                    """,
                    (
                        event["event_id"],
                        session_id,
                        event["event_seq"],
                        event["type"],
                        event["elapsed_ms"],
                        canonical(event),
                    ),
                )
            for bucket in timeline_buckets:
                conn.execute(
                    """
                    INSERT INTO timeline_buckets (session_id, start_ms, body)
                    VALUES (%s, %s, %s::jsonb)
                    """,
                    (session_id, bucket["elapsed_start_ms"], canonical(bucket)),
                )

    def delete(self, owner, session_id):
        with self.connection() as conn:
            row = conn.execute(
                "SELECT id FROM sessions WHERE id = %s AND owner = %s",
                (session_id, owner),
            ).fetchone()
            if row is None:
                return
            conn.execute("DELETE FROM samples WHERE session_id = %s", (session_id,))
            conn.execute("DELETE FROM events WHERE session_id = %s", (session_id,))
            conn.execute("DELETE FROM timeline_buckets WHERE session_id = %s", (session_id,))
            conn.execute(
                "UPDATE sessions SET status = 'abandoned', body = '{}'::jsonb, deleted = TRUE, revision = revision + 1 WHERE id = %s",
                (session_id,),
            )

