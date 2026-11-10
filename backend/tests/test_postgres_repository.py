import json
import unittest

from backend.ecolephant.contracts import canonical
from backend.ecolephant.errors import ApiError
from backend.ecolephant.postgres import PostgresRepository


class FakeCursor:
    def __init__(self, rows=None, rowcount=1):
        self._rows = list(rows or [])
        self.rowcount = rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakePostgresConnection:
    """실제 PostgreSQL의 MVCC 행 단위 락, REPEATABLE READ 격리 수준, UNIQUE/낙관적 락 동작을 재현하는 테스트용 인메모리 어댑터."""

    def __init__(self, state, simulate_race_on_insert=False):
        self.state = state
        self.simulate_race_on_insert = simulate_race_on_insert
        self.queries = []
        self.committed = False
        self.rolled_back = False

    def execute(self, sql, params=()):
        normalized = " ".join(sql.split())
        self.queries.append((normalized, params))

        if normalized.startswith("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"):
            self.state["isolation_levels"].append("REPEATABLE READ")
            return FakeCursor()

        if normalized.startswith("INSERT INTO policies"):
            policy_id, body = params
            if policy_id not in self.state["policies"]:
                self.state["policies"][policy_id] = json.loads(body)
                return FakeCursor(rowcount=1)
            return FakeCursor(rowcount=0)

        if normalized.startswith("SELECT body FROM policies WHERE id = %s"):
            policy_id = params[0]
            body = self.state["policies"].get(policy_id)
            return FakeCursor([{"body": body}] if body is not None else [])

        if normalized.startswith("SELECT deleted, body FROM sessions WHERE owner = %s"):
            owner, client_id, idem_key = params
            matches = [
                {"deleted": row["deleted"], "body": row["body"]}
                for row in self.state["sessions"].values()
                if row["owner"] == owner and (row["client_id"] == client_id or row["idem_key"] == idem_key)
            ]
            return FakeCursor(matches)

        if normalized.startswith("INSERT INTO sessions"):
            (
                session_id,
                owner,
                client_id,
                idem_key,
                status,
                requested_mode,
                policy_id,
                data_source,
                started_at,
                ended_at,
                body,
            ) = params
            # Q1 시나리오: find_create 통과 직후 0.001초 차이로 다른 요청이 먼저 INSERT를 완료한 경쟁 상태(Race Condition) 재현
            if self.simulate_race_on_insert is not None and callable(self.simulate_race_on_insert):
                self.simulate_race_on_insert(self.state)
            for existing in self.state["sessions"].values():
                if existing["owner"] == owner and (
                    existing["client_id"] == client_id or existing["idem_key"] == idem_key
                ):
                    return FakeCursor(rowcount=0)
            self.state["sessions"][session_id] = {
                "id": session_id,
                "owner": owner,
                "client_id": client_id,
                "idem_key": idem_key,
                "status": status,
                "requested_mode": requested_mode,
                "policy_id": policy_id,
                "data_source": data_source,
                "started_at": started_at,
                "ended_at": ended_at,
                "body": json.loads(body),
                "revision": 0,
                "deleted": False,
            }
            return FakeCursor(rowcount=1)

        if normalized.startswith("SELECT body FROM sessions WHERE id = %s AND owner = %s AND deleted = FALSE"):
            session_id, owner = params
            row = self.state["sessions"].get(session_id)
            if not row or row["owner"] != owner or row["deleted"]:
                return FakeCursor([])
            return FakeCursor([{"body": row["body"]}])

        if normalized.startswith("UPDATE sessions SET status = %s"):
            status, ended_at, body, new_rev, session_id, owner, expected_rev = params
            row = self.state["sessions"].get(session_id)
            # Q2 시나리오: 낙관적 락(WHERE revision = %s) 비교
            if not row or row["owner"] != owner or row["deleted"] or row["revision"] != expected_rev:
                return FakeCursor(rowcount=0)
            row.update(status=status, ended_at=ended_at, body=json.loads(body), revision=new_rev)
            return FakeCursor(rowcount=1)

        if normalized.startswith("SELECT seq, body FROM samples"):
            session_id = params[0]
            rows = sorted(self.state["samples"].get(session_id, []), key=lambda r: r["seq"])
            return FakeCursor(rows)

        if normalized.startswith("SELECT seq, body FROM events"):
            session_id = params[0]
            rows = sorted(self.state["events"].get(session_id, []), key=lambda r: r["seq"])
            return FakeCursor(rows)

        if normalized.startswith("INSERT INTO samples"):
            session_id, seq, elapsed_start_ms, duration_ms, active_mode, body = params
            bucket = self.state["samples"].setdefault(session_id, [])
            if any(r["seq"] == seq for r in bucket):
                class UniqueViolation(Exception):
                    pass
                raise UniqueViolation("duplicate sample seq")
            bucket.append({"seq": seq, "body": json.loads(body)})
            return FakeCursor(rowcount=1)

        return FakeCursor()

    def commit(self):
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def close(self):
        pass


def make_sample_record(session_id="sess-1", client_id="client-1", revision=0):
    payload = {
        "client_session_id": client_id,
        "started_at": "2026-11-10T10:00:00Z",
        "requested_mode": "imu",
        "policy_id": "default-v1",
        "data_source": "demo",
        "initial_calibration_epoch": 1,
    }
    session = {
        "id": session_id,
        "client_session_id": client_id,
        "started_at": "2026-11-10T10:00:00Z",
        "ended_at": None,
        "status": "active",
        "requested_mode": "imu",
        "policy_id": "default-v1",
        "data_source": "demo",
        "final_seq": None,
        "final_event_seq": None,
        "acknowledged_through_seq": 0,
        "acknowledged_through_event_seq": 0,
        "summaries": [],
        "unassigned_unknown_duration_ms": 0,
    }
    return payload, {"session": session, "create": payload, "revision": revision}


class PostgresRepositoryDay2ConcurrencyTest(unittest.TestCase):
    def setUp(self):
        self.state = {"policies": {}, "sessions": {}, "samples": {}, "events": {}, "isolation_levels": []}

    def test_concurrent_duplicate_create_returns_existing_session_idempotently(self):
        """[Q1 검증] 0.001초 차이 따닥 클릭으로 INSERT 시점에 UNIQUE 충돌이 나더라도 500 에러 대신 기존 세션을 반환해야 합니다."""
        payload, record_winner = make_sample_record(session_id="sess-winner")
        _, record_second = make_sample_record(session_id="sess-second")

        def inject_winner_before_insert(state):
            state["sessions"]["sess-winner"] = {
                "id": "sess-winner",
                "owner": "user-1",
                "client_id": payload["client_session_id"],
                "idem_key": "idem-1",
                "status": "active",
                "requested_mode": "imu",
                "policy_id": "default-v1",
                "data_source": "demo",
                "started_at": payload["started_at"],
                "ended_at": None,
                "body": json.loads(canonical(record_winner)),
                "revision": 0,
                "deleted": False,
            }

        repo = PostgresRepository(
            "postgresql://localhost/ecolephant",
            connect_fn=lambda _: FakePostgresConnection(self.state, simulate_race_on_insert=inject_winner_before_insert),
        )
        # 허용 케이스: 똑같은 payload로 따닥 요청이 들어왔을 때는 먼저 생성된 sess-winner를 그대로 반환!
        result = repo.create("user-1", "idem-1", payload, record_second)
        self.assertEqual(result["session"]["id"], "sess-winner")

        # 거부 케이스: 같은 idem_key인데 다른 payload(예: requested_mode='webcam')로 동시 요청이 들어오면 409 idempotency_conflict 차단!
        conflicting_payload = {**payload, "requested_mode": "webcam"}
        with self.assertRaises(ApiError) as ctx:
            repo.create("user-1", "idem-1", conflicting_payload, record_second)
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(ctx.exception.code, "idempotency_conflict")

    def test_optimistic_lock_revision_blocks_lost_update_on_concurrent_commit(self):
        """[Q2 검증] 낙관적 락(revision): 동시에 같은 revision=0을 읽은 두 요청 중 두 번째 요청은 409 concurrent_write로 차단되어야 합니다."""
        payload, record = make_sample_record(session_id="sess-1", revision=0)
        repo = PostgresRepository(
            "postgresql://localhost/ecolephant",
            connect_fn=lambda _: FakePostgresConnection(self.state),
        )
        repo.create("user-1", "idem-1", payload, record)

        # 첫 번째 요청이 revision=0으로 커밋 -> 성공하며 DB의 revision은 1로 증가
        repo.commit("user-1", record)
        self.assertEqual(self.state["sessions"]["sess-1"]["revision"], 1)

        # 아직 옛날 revision=0을 들고 있던 두 번째 동시 요청이 뒤늦게 커밋 시도 -> 409 concurrent_write 거부!
        with self.assertRaises(ApiError) as ctx:
            repo.commit("user-1", record)
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(ctx.exception.code, "concurrent_write")

    def test_multi_table_loads_enforce_repeatable_read_isolation(self):
        """[기아 선배 블로그 #1 검증] 다중 테이블 조회(load, load_events)는 REPEATABLE READ 스냅샷 격리 수준을 사용해야 합니다."""
        payload, record = make_sample_record(session_id="sess-1", revision=0)
        repo = PostgresRepository(
            "postgresql://localhost/ecolephant",
            connect_fn=lambda _: FakePostgresConnection(self.state),
        )
        repo.create("user-1", "idem-1", payload, record)
        loaded = repo.load("user-1", "sess-1")
        self.assertEqual(loaded["session"]["id"], "sess-1")
        self.assertIn("REPEATABLE READ", self.state["isolation_levels"])


if __name__ == "__main__":
    unittest.main()

