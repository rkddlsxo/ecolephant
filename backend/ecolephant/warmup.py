"""무중단 배포 초기 Cold Start 방지용 사전 예열(Warm-up) 및 Deep Healthcheck"""


def warmup_and_check_readiness(repository=None, redis_coord=None):
    """새 백엔드 컨테이너가 켜졌을 때 첫 손님이 느리지 않도록 DB 커넥션 풀과 Redis를 미리 1번 예열(Warm-up)하고 상태를 반환합니다."""
    db_ok = True
    cache_ok = True

    # DB 커넥션 풀 사전 예열 (Warm-up):
    # 첫 손님이 올 때 비로소 DB 연결을 맺으면 첫 요청만 유독 느려지므로(Cold Start),
    # 컨테이너가 켜질 때 미리 repository.connection()을 1번 열었다가 반납해 전화기 보관함(_pool)에 연결을 미리 채워 둡니다!
    if repository is not None and hasattr(repository, "connection"):
        try:
            with repository.connection():
                pass
        except Exception:
            db_ok = False

    # Redis 캐시 연결 확인 (선택적 보조 칠판이므로 죽어 있어도 cache_ok만 False로 표시)
    if redis_coord is not None:
        try:
            redis_coord.get_cached_statistics("__warmup__", "ping")
        except Exception:
            cache_ok = False

    return {
        "ready": db_ok,
        "db": "ok" if db_ok else "unavailable",
        "cache": "ok" if cache_ok else "degraded",
    }
