-- PostgreSQL 스키마: 자주 검색하는 값은 컬럼으로, 나머지는 JSONB (body)에 저장

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    client_id TEXT NOT NULL,
    idem_key TEXT NOT NULL,

    -- JSON 파싱 없이 DB가 즉시 필터링·정렬·인덱싱할 수 있습니다.
    status TEXT NOT NULL DEFAULT 'active', -- 현재상태 (active="측정중", completed=완료)
    requested_mode TEXT NOT NULL DEFAULT 'imu',--측정모드 (imu=센서, webcam =카메라, combined = 둘다)
    policy_id TEXT NOT NULL, --어떤 자세 기준표(정책)로 측정했는지
    data_source TEXT NOT NULL DEFAULT 'demo', --에모 데이터(demo)인지 실제 측정(real)인지
    started_at TIMESTAMPTZ NOT NULL, --측정 시작 시간 (UTC)
    ended_at TIMESTAMPTZ, --측정 종료 시간 (UTC) (측정 중일 댄 아직 안 끝났으니 비어있을 수 있음 = not null 안붙임: null 무결성)
    
    -- 기존 API 응답 계약을 100% 보존하기 위해 전체 레코드 메타데이터는 이진 JSON(JSONB)으로 함께 보관합니다.
    body JSONB NOT NULL,
    -- 동시 수정 충돌을 막기 위한 낙관적 락(Optimistic Lock) 버전 번호입니다.
    revision INTEGER NOT NULL DEFAULT 0,
    -- 삭제된 세션이 지연 도착한 재시도 요청 때문에 부활하지 않도록 막는 Tombstone 표시입니다.
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (owner, client_id), --같은 유저가 같은 client_id로 세션을 두 번 못 만들게 막음
    UNIQUE (owner, idem_key)  -- 같은 유저가 같은 중복방지 키(idem_key)로 두번 못 만들게 막음
);

CREATE TABLE IF NOT EXISTS samples (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    elapsed_start_ms BIGINT NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    active_mode TEXT NOT NULL DEFAULT 'imu',
    body JSONB NOT NULL,
    PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'alert_delivery',
    elapsed_ms BIGINT NOT NULL DEFAULT 0,
    body JSONB NOT NULL,
    UNIQUE (session_id, seq)
);

CREATE TABLE IF NOT EXISTS timeline_buckets (
    session_id TEXT NOT NULL,
    start_ms BIGINT NOT NULL,
    body JSONB NOT NULL,
    PRIMARY KEY (session_id, start_ms)
);

CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    body JSONB NOT NULL
);

--내 세션 목록 조회를 빠르게 하는 인덱스
--삭제된 세션은 제외해서 용량 절약
CREATE INDEX IF NOT EXISTS idx_sessions_owner_started
    ON sessions (owner,started_at,status)
    WHERE deleted = FALSE;

