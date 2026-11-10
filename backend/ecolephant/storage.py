"""Atomic local persistence. The application service also works with DynamoRepository."""
from contextlib import contextmanager
from pathlib import Path
import json
import sqlite3

from .contracts import canonical
from .errors import ApiError

# 지금의 sessions 테이블은 세션의 시작 시간 (started_at), 상태(status: 측정 중/완료), 총 측정 시간 (duration_ms) 등을
# body TEXT 하나에 JSON 문자열로 뭉뚱그려 저장하므로, 조건 검색 시 DB 인덱스를 타지 못하고 파이썬에서 매번 json.loads()로 파싱해야 합니다.

# 이런식의 코드는 긴 소설책 한 줄 (Text)처럼 보여서 조건을 건 것만 찾아줘 이럴때 DB가 바로 못 찾고, 파이썬이 모든 줄을 다 꺼내서 읽어야했다.
class SQLiteRepository:
    def __init__(self, database):
        self.database = str(database)
        Path(database).parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as conn:
            conn.executescript("""
                PRAGMA journal_mode=WAL;
                
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_id TEXT NOT NULL,
                    idem_key TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(owner, client_id), UNIQUE(owner, idem_key));
                CREATE TABLE IF NOT EXISTS samples (
                    session_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL,
                    PRIMARY KEY(session_id, seq));
                CREATE TABLE IF NOT EXISTS events (
                    event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                    seq INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(session_id, seq));
                CREATE TABLE IF NOT EXISTS timeline_buckets (
                    session_id TEXT NOT NULL, start_ms INTEGER NOT NULL, body TEXT NOT NULL,
                    PRIMARY KEY(session_id, start_ms));
                CREATE TABLE IF NOT EXISTS policies (
                    id TEXT PRIMARY KEY, body TEXT NOT NULL);
            """)

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.database, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def ensure_policy(self, policy):
        body = canonical(policy)
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("INSERT OR IGNORE INTO policies VALUES (?,?)", (policy["policy_id"], body))
            existing = conn.execute("SELECT body FROM policies WHERE id=?", (policy["policy_id"],)).fetchone()
            if existing["body"] != body:
                raise ApiError(409, "policy_id_conflict", "이미 등록된 정책 ID의 내용이 다릅니다.")

    def find_create(self, owner, key, payload, conn=None):
        if conn is None:
            with self.connection() as connection:
                return self.find_create(owner, key, payload, connection)
        matches = conn.execute("SELECT * FROM sessions WHERE owner=? AND (client_id=? OR idem_key=?)",
                               (owner, payload["client_session_id"], key)).fetchall()
        if not matches:
            return None
        if any(row["deleted"] or json.loads(row["body"])["create"] != payload for row in matches) or len(matches) > 1:
            raise ApiError(409, "idempotency_conflict", "같은 시작 식별자에 다른 내용이 있습니다.")
        return json.loads(matches[0]["body"])

    def create(self, owner, key, payload, record):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = self.find_create(owner, key, payload, conn)
            if existing is not None:
                return existing
            conn.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?,0)",
                         (record["session"]["id"], owner, payload["client_session_id"], key, canonical(record), 0))
            return record

    def _metadata(self, conn, owner, session_id):
        row = conn.execute("SELECT body FROM sessions WHERE id=? AND owner=? AND deleted=0", (session_id, owner)).fetchone()
        if row is None:
            raise ApiError(404, "not_found", "기록을 찾을 수 없습니다.")
        return json.loads(row["body"])

    def load_metadata(self, owner, session_id):
        with self.connection() as conn:
            return self._metadata(conn, owner, session_id)

    def load_events(self, owner, session_id):
        with self.connection() as conn:
            conn.execute("BEGIN")
            record = self._metadata(conn, owner, session_id)
            record["events"] = {r["seq"]: json.loads(r["body"]) for r in conn.execute(
                "SELECT seq,body FROM events WHERE session_id=? ORDER BY seq", (session_id,))}
            return record

    def load_timeline_buckets(self, owner, session_id, low, high, revision):
        with self.connection() as conn:
            conn.execute("BEGIN")
            record = self._metadata(conn, owner, session_id)
            if record["revision"] != revision:
                raise ApiError(409, "concurrent_write", "기록이 변경되었습니다. 다시 시도해 주세요.")
            return [json.loads(row["body"]) for row in conn.execute(
                "SELECT body FROM timeline_buckets WHERE session_id=? AND start_ms>=? AND start_ms<? ORDER BY start_ms",
                (session_id, low, high))]

    def load(self, owner, session_id):
        with self.connection() as conn:
            conn.execute("BEGIN")
            record = self._metadata(conn, owner, session_id)
            record["samples"] = {r["seq"]: json.loads(r["body"]) for r in conn.execute("SELECT seq,body FROM samples WHERE session_id=? ORDER BY seq", (session_id,))}
            record["events"] = {r["seq"]: json.loads(r["body"]) for r in conn.execute("SELECT seq,body FROM events WHERE session_id=? ORDER BY seq", (session_id,))}
            return record


    def list(self, owner):
        with self.connection() as conn:
            return [json.loads(row["body"])["session"] for row in conn.execute("SELECT body FROM sessions WHERE owner=? AND deleted=0", (owner,))]

    def commit(self, owner, record, samples=(), events=(), timeline_buckets=()):
        session_id, revision = record["session"]["id"], record["revision"]
        stored = {k: v for k, v in record.items() if k not in {"samples", "events"}}
        stored["revision"] = revision + 1
        try:
            with self.connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                updated = conn.execute("UPDATE sessions SET body=?, revision=? WHERE id=? AND owner=? AND revision=? AND deleted=0",
                                       (canonical(stored), revision + 1, session_id, owner, revision))
                if updated.rowcount != 1:
                    raise ApiError(409, "concurrent_write", "기록이 변경되었습니다. 같은 요청을 다시 보내 주세요.")
                for sample in samples:
                    conn.execute("INSERT INTO samples VALUES (?,?,?)", (session_id, sample["seq"], canonical(sample)))
                for event in events:
                    conn.execute("INSERT INTO events VALUES (?,?,?,?)", (event["event_id"], session_id, event["event_seq"], canonical(event)))
                for bucket in timeline_buckets:
                    conn.execute("INSERT INTO timeline_buckets VALUES (?,?,?)",
                                 (session_id, bucket["elapsed_start_ms"], canonical(bucket)))
        except sqlite3.IntegrityError:
            raise ApiError(409, "identity_conflict", "이미 사용된 결과 또는 이벤트 식별자입니다.") from None

    def delete(self, owner, session_id):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT id FROM sessions WHERE id=? AND owner=?", (session_id, owner)).fetchone()
            if row is None:
                return
            conn.execute("DELETE FROM samples WHERE session_id=?", (session_id,))
            conn.execute("DELETE FROM events WHERE session_id=?", (session_id,))
            conn.execute("DELETE FROM timeline_buckets WHERE session_id=?", (session_id,))
            # Retain only an identity tombstone so a delayed create retry cannot resurrect data.
            conn.execute("UPDATE sessions SET body='{}', deleted=1, revision=revision+1 WHERE id=?", (session_id,))
