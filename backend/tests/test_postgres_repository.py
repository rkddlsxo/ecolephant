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

        if normalized.startswith("SELECT id, body FROM sessions WHERE owner = %s AND deleted = FALSE AND id = ANY(%s)"):
            owner, ids = params
            rows = [
                {"id": sid, "body": self.state["sessions"][sid]["body"]}
                for sid in ids
                if sid in self.state["sessions"]
                and self.state["sessions"][sid]["owner"] == owner
                and not self.state["sessions"][sid]["deleted"]
            ]
            return FakeCursor(rows)

        if normalized.startswith("SELECT session_id, seq, body FROM samples WHERE session_id = ANY(%s) ORDER BY seq"):
            (ids,) = params
            rows = []
            for sid in ids:
                for r in sorted(self.state["samples"].get(sid, []), key=lambda item: item["seq"]):
                    rows.append({"session_id": sid, "seq": r["seq"], "body": r["body"]})
            return FakeCursor(rows)

        if normalized.startswith("SELECT session_id, seq, body FROM events WHERE session_id = ANY(%s) ORDER BY seq"):
            (ids,) = params
            rows = []
            for sid in ids:
                for r in sorted(self.state["events"].get(sid, []), key=lambda item: item["seq"]):
                    rows.append({"session_id": sid, "seq": r["seq"], "body": r["body"]})
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

    def test_load_many_eliminates_n_plus_1_with_batch_any_queries(self):
        """[Day 3 검증] 세션 5개를 load_many로 조회할 때 15번(N+1)이 아니라 단 3번의 SELECT(ANY 배치)로 샘플까지 모두 가져와야 합니다."""
        connections = []

        def open_conn(_):
            conn = FakePostgresConnection(self.state)
            connections.append(conn)
            return conn

        repo = PostgresRepository("postgresql://localhost/ecolephant", connect_fn=open_conn)
        session_ids = [f"sess-{i}" for i in range(1, 6)]
        for i, sid in enumerate(session_ids, start=1):
            payload, record = make_sample_record(session_id=sid, client_id=f"client-{i}", revision=0)
            repo.create("user-1", f"idem-{i}", payload, record)
            repo.commit(
                "user-1",
                record,
                samples=[
                    {
                        "seq": 1,
                        "elapsed_start_ms": 0,
                        "duration_ms": 5000,
                        "active_mode": "imu",
                        "calibration_epoch": 1,
                    }
                ],
            )

        connections.clear()
        records = repo.load_many("user-1", session_ids)
        self.assertEqual([r["session"]["id"] for r in records], session_ids)
        # 5개 세션 각각의 samples(seq=1)가 빠짐없이 채워져 있어야 합니다!
        for rec in records:
            self.assertIn(1, rec["samples"])
        # 트랜잭션 딱 1번, SELECT 쿼리 딱 3번(sessions, samples, events)만 실행되었는지 증명!
        self.assertEqual(len(connections), 1)
        select_queries = [q for q, _ in connections[0].queries if q.startswith("SELECT")]
        self.assertEqual(len(select_queries), 3)


if __name__ == "__main__":
    unittest.main()

