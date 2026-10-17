"""Atomic local persistence. The application service also works with DynamoRepository."""
from contextlib import contextmanager
from pathlib import Path
import json
import sqlite3

from .contracts import canonical
from .errors import ApiError


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

    def create(self, owner, key, payload, record):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            matches = conn.execute("SELECT * FROM sessions WHERE owner=? AND (client_id=? OR idem_key=?)",
                                   (owner, payload["client_session_id"], key)).fetchall()
            if matches:
                existing = json.loads(matches[0]["body"])
                if any(row["deleted"] or json.loads(row["body"])["create"] != payload for row in matches) or len(matches) > 1:
                    raise ApiError(409, "idempotency_conflict", "같은 시작 식별자에 다른 내용이 있습니다.")
                return existing
            conn.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?,0)",
                         (record["session"]["id"], owner, payload["client_session_id"], key, canonical(record), 0))
            return record

    def load(self, owner, session_id):
        with self.connection() as conn:
            conn.execute("BEGIN")
            row = conn.execute("SELECT body FROM sessions WHERE id=? AND owner=? AND deleted=0", (session_id, owner)).fetchone()
            if row is None:
                raise ApiError(404, "not_found", "기록을 찾을 수 없습니다.")
            record = json.loads(row["body"])
            record["samples"] = {r["seq"]: json.loads(r["body"]) for r in conn.execute("SELECT seq,body FROM samples WHERE session_id=?", (session_id,))}
            record["events"] = {r["seq"]: json.loads(r["body"]) for r in conn.execute("SELECT seq,body FROM events WHERE session_id=?", (session_id,))}
            return record

    def list(self, owner):
        with self.connection() as conn:
            return [json.loads(row["body"])["session"] for row in conn.execute("SELECT body FROM sessions WHERE owner=? AND deleted=0", (owner,))]

    def commit(self, owner, record, samples=(), events=()):
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
            # Retain only an identity tombstone so a delayed create retry cannot resurrect data.
            conn.execute("UPDATE sessions SET body='{}', deleted=1, revision=revision+1 WHERE id=?", (session_id,))
