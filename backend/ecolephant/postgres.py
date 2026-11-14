"""PostgreSQL """
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
import json

from .contracts import canonical
from .errors import ApiError

SCHEMA_PATH = Path(__file__).resolve().parent / "sql/schema.sql"

# JSON 데이터를 파이썬 딕셔너리로 변환
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

    # DB와 connection을 새로 여는 함수
    def _open_connection(self):
        if self._connect_fn is not None:
            return self._connect_fn(self.dsn)
        import psycopg
        from psycopg.rows import dict_row

        return psycopg.connect(self.dsn, row_factory=dict_row, autocommit=False)

    # Connection을 관리하는 함수
    # 연결 열기 -> 쿼리 성공하면 저장(commit) -> 에러 나면 취소(rollback) -> 닫기(close)
    @contextmanager
    def connection(self, *, repeatable_read=False):
        try:
            conn = self._open_connection()
        except Exception:
            raise ApiError(503, "storage_unavailable", "저장소를 다시 연결해 주세요.") from None
        try:
            # 격리수준: repeatable read
            # 트랜잭션 시작 시점의 스냅샷으로 고정 -> session.samples를 같은 시점 기준으로 읽기 위함.
            # 기본값 read commited는 select마다 최신 데이터를 봐서, 중간에 다른 요청이 수정하면 두 결과가 어긋날 수 있음.
            if repeatable_read:
                conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            yield conn
            conn.commit()
        except ApiError:
            conn.rollback()
            raise
        except Exception as exc:
            conn.rollback()
            # 이미 있는 번호(PK/UNIQUE)를 또 넣으려고 하면 500 서버 폭주 에러 대신 409 중복 에러로 바꿔서 알려줌.
            if exc.__class__.__name__ in {"UniqueViolation", "IntegrityError"}:
                raise ApiError(409, "identity_conflict", "이미 사용된 결과 또는 이벤트 식별자입니다.") from None
            raise ApiError(503, "storage_unavailable", "저장소를 다시 연결해 주세요.") from None
        finally:
            conn.close()

    # 판정 정책(예: draft-web-v1, draft-web-v2)을 DB에 등록.
    # ON CONFLICT DO NOTHING: 이미 똑같은 정책 ID가 들어있으면 에러 내지 말고 그냥 넘어가라는 뜻.
    # 단, 이름은 같은데 안의 기준값 내용이 다르면 409 에러(policy_id_conflict)로 막아줌.
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

    # '측정 시작' 버튼을 눌렀을 때, 혹시 똑같은 요청(client_id 또는 idem_key)으로 이미 만들어진 세션이 있는지 먼저 찾아봄.
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
        # 이미 있는 시작 번호인데 아까 보냈던 요청 내용(payload)과 다르면 409 에러로 거부.
        if (
            any(bool(row["deleted"]) or item.get("create") != payload for row, item in zip(matches, decoded))
            or len(matches) > 1
        ):
            raise ApiError(409, "idempotency_conflict", "같은 시작 식별자에 다른 내용이 있습니다.")
        return decoded[0]

    # 새 측정 세션을 만듬.
    def create(self, owner, key, payload, record):
        session = record["session"]
        with self.connection() as conn:
            existing = self.find_create(owner, key, payload, conn)
            if existing is not None:
                return existing
            # Race Condition 방어
            # 새 세션을 만듦. 동시에 2개가 들어와도 on conflict do nothing으로 에러 안내고 첫 번째 세션을 돌려줌
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

    # 세션 1개의 기본 정보(body)만 꺼내오는 내부 도우미 함수. 없거나 삭제된 세션이면 404 에러.
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

    # 세션 정보 + 경고 이벤트 목록(events)만 함께 읽음. (표 2개를 읽으므로 repeatable_read 스냅샷을 켭니다)
    def load_events(self, owner, session_id):
        with self.connection(repeatable_read=True) as conn:
            record = self._metadata(conn, owner, session_id)
            rows = conn.execute(
                "SELECT seq, body FROM events WHERE session_id = %s ORDER BY seq",
                (session_id,),
            ).fetchall()
            record["events"] = {row["seq"]: _decode_json(row["body"]) for row in rows}
            return record

    # 타임라인 그래프에 그릴 1분 단위 요약 구간(timeline_buckets)을 읽어옴.
    # 읽는 도중에 다른 요청이 세션을 고쳐서 버전(revision)이 바뀌었으면 409 에러로 알려줌.
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

    # 세션 1개의 전체 기록(세션 기본정보 + 5초 단위 샘플 + 이벤트)을 모두 읽어옴.
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

    # N+1 문제 해결
    # 통계화면에서 세션 100개를 조회할 때 for 문으로 300번 물어보는 대신, any(%s)에 리스트를 통째로 넣어 딱 3번만 물어봄
    def load_many(self, owner, session_ids):
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

    # 내(owner)가 측정한 세션 목록 전체를 가져옴.
    def list(self, owner):
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT body FROM sessions WHERE owner = %s AND deleted = FALSE",
                (owner,),
            ).fetchall()
            return [_decode_json(row["body"])["session"] for row in rows]

    # 측정 중에 들어온 5초 샘플(samples), 이벤트(events), 1분 요약(timeline_buckets)을 DB에 저장.
    def commit(self, owner, record, samples=(), events=(), timeline_buckets=()):
        session = record["session"]
        session_id, revision = session["id"], record["revision"]
        stored = {k: v for k, v in record.items() if k not in {"samples", "events"}}
        stored["revision"] = revision + 1
        with self.connection() as conn:
            # where revision = %s 로 내가 읽었던 버전 번호가 맞을 때만 저장하고 +1 올려서 덮어쓰기 방지
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

    # 세션 삭제 시 하위 샘플은 지우되, sessions 줄은 아예 안 지우고, deleted = true 표시만 남김(삭제된 세션이 다시 살아나는 것 방지)
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
