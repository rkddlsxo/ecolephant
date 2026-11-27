"""ErrorWatcher:
Prometheus/CloudWatch 알람이나 백엔드 5xx 장애 로그가 발생했을 때,
AWS Lambda + Bedrock(Claude)을 통해 1) 심각도(CRITICAL/WARNING), 2) 근본 원인(RCA),
3) 침해 반경(Blast Radius), 4) 즉시 복구 명령어(Runbook)를 자동 진단해 Slack/SNS로 브리핑하는 AIOps 모듈.
"""

RUNBOOK_CATALOG = {
    "storage_unavailable": {
        "root_cause": "PostgreSQL(RDS) 커넥션 풀 고갈 또는 보안그룹(5432 포트) 연결 끊김",
        "blast_radius": "신규 세션 생성 및 배치 저장(POST) 일시 중단 (기존 캐시 통계 조회는 Redis로 정상 응답)",
        "recovery_cmd": "docker compose -f compose.yml -f compose.postgres.yml restart postgres backend",
    },
    "HostLowAvailableMemory": {
        "root_cause": "EC2 가용 메모리 15% 미만 경고 (컨테이너 메모리 스파이크 또는 Swap 사용 증가)",
        "blast_radius": "OOM Killer 작동 시 백엔드 워커 강제 종료 위험",
        "recovery_cmd": "free -m && swapon -s && docker stats --no-stream",
    },
    "QueueBacklogHigh": {
        "root_cause": "RabbitMQ/SQS 측정 배치 대기열 적체 (Consumer 처리 속도보다 유입량 초과)",
        "blast_radius": "실시간 타임라인 반영 지연 (Producer는 정상 접수 중이므로 데이터 유실 없음)",
        "recovery_cmd": "python -c 'from backend.ecolephant.queue_worker import BatchQueueCoordinator; BatchQueueCoordinator().replay_dead_letters()'",
    },
}


def analyze_cloud_incident(alert_name, error_code=None, latency_ms=0.0, llm_fn=None):
    """[Monitor -> Detective -> Reporter] 장애 알람을 받아 원인(RCA)과 복구 명령어 보고서를 생성합니다."""
    lookup_key = error_code or alert_name
    base_guide = RUNBOOK_CATALOG.get(
        lookup_key,
        {
            "root_cause": f"알 수 없는 클라우드 알람 감지 ({lookup_key})",
            "blast_radius": "개별 컨테이너 로그 점검 필요",
            "recovery_cmd": "bash scripts/rolling-update.sh",
        },
    )
    severity = "CRITICAL" if (latency_ms >= 2000 or error_code == "storage_unavailable") else "WARNING"

    report = {
        "incident": lookup_key,
        "severity": severity,
        "root_cause": base_guide["root_cause"],
        "blast_radius": base_guide["blast_radius"],
        "recovery_cmd": base_guide["recovery_cmd"],
    }

    if llm_fn is not None:
        try:
            report["ai_diagnosis"] = llm_fn(report)
        except Exception:
            report["ai_diagnosis"] = "Bedrock 일시 지연: 기본 런북(Runbook) 가이드를 우선 적용하세요."

    return report
