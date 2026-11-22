"""Static contract tests for Terraform, Ansible, and zero-downtime deployment configs."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
TF_OIDC = ROOT / "infra" / "terraform" / "oidc"
TF_MAIN = ROOT / "infra" / "terraform" / "main"
ANSIBLE_DIR = ROOT / "infra" / "ansible"
NGINX_CONF = ROOT / "deploy" / "nginx.conf"


class TerraformAndAnsibleContractTests(unittest.TestCase):
    def test_oidc_module_enforces_github_audience_and_repo_scope(self):
        main_tf = (TF_OIDC / "main.tf").read_text(encoding="utf-8")
        self.assertIn("https://token.actions.githubusercontent.com", main_tf)
        self.assertIn("token.actions.githubusercontent.com:aud", main_tf)
        self.assertIn("sts.amazonaws.com", main_tf)
        self.assertIn("token.actions.githubusercontent.com:sub", main_tf)
        self.assertIn("repo:${var.github_repository}:ref:refs/heads/${var.allowed_branch}", main_tf)
        self.assertIn("arn:aws:iam::*:role/ecolephant-*", main_tf)

    def test_main_terraform_avoids_expensive_resources_and_hardens_security(self):
        main_tf = (TF_MAIN / "main.tf").read_text(encoding="utf-8")
        forbidden_resources = (
            'resource "aws_route53_zone"',
            'resource "aws_acm_certificate"',
            'resource "aws_nat_gateway"',
            'resource "aws_eip"',
            'resource "aws_rds_cluster"',
            'resource "aws_eks_cluster"',
            'resource "aws_lb"',
            'resource "aws_iam_role"',
        )
        for resource in forbidden_resources:
            self.assertNotIn(resource, main_tf, f"인하대 캡스톤 지원 불가/오버킬 리소스 발견: {resource}")

        self.assertIn('billing_mode = "PAY_PER_REQUEST"', main_tf)
        self.assertIn("point_in_time_recovery", main_tf)
        self.assertIn('http_tokens   = "required"', main_tf)
        self.assertIn("encrypted   = true", main_tf)
        self.assertIn("block_public_acls       = true", main_tf)
        self.assertIn("restrict_public_buckets = true", main_tf)
        # RDS 필수 가이드: Single-AZ(multi_az = false), 퍼블릭 액세스 차단(publicly_accessible = false)
        self.assertIn("multi_az               = false", main_tf)
        self.assertIn("publicly_accessible    = false", main_tf)
        # SQS + DLQ 및 API Gateway HTTPS 엔드포인트 포함 확인
        self.assertIn('resource "aws_sqs_queue" "batch_queue"', main_tf)
        self.assertIn('resource "aws_sqs_queue" "batch_dlq"', main_tf)
        self.assertIn('resource "aws_apigatewayv2_api" "https_gateway"', main_tf)

    def test_ansible_playbook_configures_ufw_systemd_and_rolling_update(self):
        playbook = (ANSIBLE_DIR / "playbook.yml").read_text(encoding="utf-8")
        unit_tpl = (ANSIBLE_DIR / "templates" / "ecolephant.service.j2").read_text(encoding="utf-8")
        self.assertIn("community.general.ufw", playbook)
        self.assertIn("scripts/rolling-update.sh", playbook)
        self.assertIn("ExecReload=/bin/bash {{ app_dir }}/scripts/rolling-update.sh", unit_tpl)
        self.assertIn("compose.monitoring.yml", unit_tpl)

    def test_nginx_conf_uses_valid_comments_and_serves_mediapipe_assets(self):
        nginx_conf = NGINX_CONF.read_text(encoding="utf-8")
        for idx, line in enumerate(nginx_conf.splitlines(), start=1):
            stripped = line.strip()
            self.assertFalse(
                stripped.startswith("//"),
                f"deploy/nginx.conf {idx}행: Nginx는 '//' 주석을 지원하지 않습니다 ('#' 사용 필요)",
            )
        self.assertIn("location /mediapipe/", nginx_conf)
        self.assertIn("try_files $uri =404;", nginx_conf)
        self.assertIn("application/wasm", nginx_conf)

    def test_github_workflows_do_not_reference_secrets_in_if_conditions(self):
        workflows_dir = ROOT / ".github" / "workflows"
        for wf in workflows_dir.glob("*.yml"):
            for idx, line in enumerate(wf.read_text(encoding="utf-8").splitlines(), start=1):
                stripped = line.strip()
                if stripped.startswith("if:"):
                    self.assertNotIn(
                        "secrets.",
                        stripped,
                        f"{wf.name} {idx}행: GitHub Actions는 step/job if 조건문에 secrets.* 직접 참조를 허용하지 않습니다",
                    )

    def test_alertmanager_enforces_env_webhook_and_send_resolved(self):
        """[Day 13 검증] Alertmanager는 웹훅 URL을 평문 노출 없이 환경변수(${SLACK_WEBHOOK_URL})로 받고 send_resolved: true를 켜야 합니다."""
        am_text = (ROOT / "deploy" / "monitoring" / "alertmanager.yml").read_text(encoding="utf-8")
        prom_text = (ROOT / "deploy" / "monitoring" / "prometheus.yml").read_text(encoding="utf-8")
        self.assertIn("${SLACK_WEBHOOK_URL}", am_text)
        self.assertNotIn("hooks.slack.com/services/", am_text)
        self.assertIn("send_resolved: true", am_text)
        self.assertIn("alertmanager:9093", prom_text)

    def test_helm_chart_and_values_align_replicas_pool_and_memory_bounds(self):
        """[Day 14 검증] Helm 차트(Chart.yaml, values.yaml)는 백엔드 이중화(replicaCount: 2), 커넥션 풀(poolSize: 8), 메모리 보호 설정을 포함해야 합니다."""
        chart_text = (ROOT / "deploy" / "helm" / "ecolephant" / "Chart.yaml").read_text(encoding="utf-8")
        values_text = (ROOT / "deploy" / "helm" / "ecolephant" / "values.yaml").read_text(encoding="utf-8")
        self.assertIn("apiVersion: v2", chart_text)
        self.assertIn("name: ecolephant", chart_text)
        self.assertIn("replicaCount: 2", values_text)
        self.assertIn("poolSize: 8", values_text)
        self.assertIn("threads: 8", values_text)
        self.assertIn("maxmemory: 128mb", values_text)

    def test_aws_limits_and_capstone_instance_profile_integration(self):
        """[Day 15 검증] t4g.small(2GB) OOM 방지용 compose.aws-limits.yml 메모리 상한과 인하대 캡스톤 사전 지급 SafeInstanceProfile-inha-capstone-20 연동을 확인합니다."""
        limits_text = (ROOT / "compose.aws-limits.yml").read_text(encoding="utf-8")
        vars_tf = (TF_MAIN / "variables.tf").read_text(encoding="utf-8")
        main_tf = (TF_MAIN / "main.tf").read_text(encoding="utf-8")
        self.assertIn("mem_limit: 256m", limits_text)
        self.assertIn("memswap_limit: 256m", limits_text)
        self.assertIn("mem_limit: 384m", limits_text)
        self.assertIn("SafeInstanceProfile-inha-capstone-20", vars_tf)
        self.assertIn("inha-capstone-20", vars_tf)
        self.assertIn("var.existing_iam_instance_profile", main_tf)

    def test_aws_preflight_check_blocks_wrong_region_and_unapproved_profile(self):
        """[Day 16 검증] AWS 프리플라이트 점검기는 서울 리전(ap-northeast-2)과 SafeInstanceProfile-inha-capstone-20만 허용하고 그 외에는 ValueError로 차단해야 합니다."""
        import importlib.util

        spec = importlib.util.spec_from_file_location("aws_preflight_check", ROOT / "scripts" / "aws-preflight-check.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        # 허용 케이스: 서울 리전 + 인하대 캡스톤 사전 지급 프로필
        result = module.verify_aws_capstone_readiness()
        self.assertTrue(result["ready"])

        # 거부 케이스 1: 엉뚱한 리전(us-east-1) 차단
        with self.assertRaises(ValueError):
            module.verify_aws_capstone_readiness(region="us-east-1")

        # 거부 케이스 2: 지급되지 않은 임의 IAM 프로필 차단
        with self.assertRaises(ValueError):
            module.verify_aws_capstone_readiness(instance_profile="custom-unapproved-profile")

        # 거부 케이스 3: t3.nano ~ t3.medium 외의 EC2 타입(예: t3.large, t4g.small) 차단
        with self.assertRaises(ValueError):
            module.verify_aws_capstone_readiness(instance_type="t3.large")

        # 거부 케이스 4: inha-capstone-20으로 시작하지 않는 S3 버킷명 차단
        with self.assertRaises(ValueError):
            module.verify_aws_capstone_readiness(s3_bucket_name="my-random-bucket")

    def test_ansible_playbook_configures_2gb_swapfile_and_swappiness_10(self):
        """[Day 17 & 19 검증] Ansible 플레이북은 t4g.small OOM 및 스왑 쓰래싱 방지를 위해 2G /swapfile과 vm.swappiness=10 설정을 포함해야 합니다."""
        playbook = (ANSIBLE_DIR / "playbook.yml").read_text(encoding="utf-8")
        self.assertIn("fallocate -l 2G /swapfile", playbook)
        self.assertIn("mkswap /swapfile", playbook)
        self.assertIn("name: vm.swappiness", playbook)
        self.assertIn('value: "10"', playbook)

    def test_memory_budget_guarantees_512mb_os_headroom_and_poster_metrics_exist(self):
        """[Day 18~20 검증] t4g.small(2048MB)에서 컨테이너 총 메모리(1376MB)를 뺀 OS 여유분이 512MB 이상(672MB)이어야 하며 포스터 지표 문서가 존재해야 합니다."""
        import importlib.util

        spec = importlib.util.spec_from_file_location("verify_memory_budget", ROOT / "scripts" / "verify-memory-budget.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        budget = module.calculate_container_memory_budget()
        self.assertTrue(budget["safe"])
        self.assertEqual(budget["allocated_containers_mb"], 1376)
        self.assertEqual(budget["os_headroom_mb"], 672)
        self.assertGreaterEqual(budget["os_headroom_mb"], 512)

        poster_doc = (ROOT / "docs" / "deploy" / "poster-metrics-summary.md").read_text(encoding="utf-8")
        self.assertIn("Before vs After", poster_doc)
        self.assertIn("vm.swappiness=10", poster_doc)

    def test_bedrock_ai_coach_lambda_handler_and_fallback_before_key_issuance(self):
        """[Lambda + Bedrock 대체 LLM API 검증] 키 발급 전(또는 장애 시)에는 규칙 기반 코칭으로 Fallback하고, 키 주입 시 LLM 응답을 반환해야 합니다."""
        from backend.ecolephant.aws_ai_coach import generate_ai_posture_coaching, lambda_handler

        stats = {"good_ratio": 0.62, "warning_count": 5, "dominant_issue": "forward_head"}

        # 1) 키 발급 전(3일 대기 중) Fallback 검증
        fallback_res = generate_ai_posture_coaching(stats, api_url="", api_key="")
        self.assertEqual(fallback_res["source"], "fallback_rule")
        self.assertIn("62.0%", fallback_res["coaching"])

        # 2) 슬랙 DM으로 API 키 발급 후 Bedrock LLM 정상 호출 검증
        llm_res = generate_ai_posture_coaching(
            stats,
            api_url="https://llm.nxtcloud.kr/v1/complete",
            api_key="nxt-test-key",
            transport_fn=lambda url, key, prompt: {"coaching": "턱을 당기고 목 스트레칭을 30초 진행해 보세요."},
        )
        self.assertEqual(llm_res["source"], "bedrock_llm")
        self.assertIn("스트레칭", llm_res["coaching"])

        # 3) AWS Lambda + API Gateway 엔트리포인트 검증
        http_resp = lambda_handler({"body": '{"good_ratio": 0.85, "warning_count": 1}'})
        self.assertEqual(http_resp["statusCode"], 200)


if __name__ == "__main__":
    unittest.main()
