"""클라우드 장애 RCA 자동 진단 및 런북 브리핑(ErrorWatcher) 단위 테스트."""
import unittest

from backend.ecolephant.hyundai_aiops_watcher import (
    analyze_cloud_incident,
    build_sns_filtered_alert,
    matches_sns_filter_policy,
)


class Day5HyundaiAIOpsWatcherTest(unittest.TestCase):
    def test_analyze_cloud_incident_classifies_critical_and_attaches_rca_runbook(self):
        # 1) DB 연결 불능(storage_unavailable) -> CRITICAL 심각도 + PostgreSQL 커넥션/보안그룹 RCA 및 복구 명령어 반환
        crit = analyze_cloud_incident(
            "Backend503Alert",
            error_code="storage_unavailable",
            latency_ms=350.0,
            llm_fn=lambda rep: f"AI 진단: {rep['incident']} 즉시 DB 컨테이너 상태를 확인하세요.",
        )
        self.assertEqual(crit["severity"], "CRITICAL")
        self.assertIn("PostgreSQL", crit["root_cause"])
        self.assertIn("docker compose", crit["recovery_cmd"])
        self.assertIn("AI 진단", crit["ai_diagnosis"])

        # 2) 일반 메모리 경고(지연 500ms < 2000ms) -> WARNING 심각도 + 메모리/스왑 확인 런북 반환
        warn = analyze_cloud_incident("HostLowAvailableMemory", latency_ms=500.0)
        self.assertEqual(warn["severity"], "WARNING")
        self.assertIn("15% 미만", warn["root_cause"])
        self.assertIn("swapon -s", warn["recovery_cmd"])

        # 3) Bedrock LLM 호출 장애 시에도 에러로 죽지 않고 기본 런북 안내로 Fallback하는지 검증
        def broken_llm(_rep):
            raise ConnectionError("Bedrock timeout")

        degraded = analyze_cloud_incident("QueueBacklogHigh", latency_ms=2500.0, llm_fn=broken_llm)
        self.assertEqual(degraded["severity"], "CRITICAL")
        self.assertIn("기본 런북", degraded["ai_diagnosis"])

    def test_sns_message_filtering_routes_only_critical_alerts_to_emergency_channel(self):
        crit_report = analyze_cloud_incident("Backend503Alert", error_code="storage_unavailable")
        warn_report = analyze_cloud_incident("HostLowAvailableMemory", latency_ms=200.0)

        crit_env = build_sns_filtered_alert(crit_report)
        warn_env = build_sns_filtered_alert(warn_report)
        emergency_policy = {"severity": ["CRITICAL"]}

        self.assertTrue(matches_sns_filter_policy(crit_env, emergency_policy))
        self.assertFalse(matches_sns_filter_policy(warn_env, emergency_policy))


if __name__ == "__main__":
    unittest.main()
