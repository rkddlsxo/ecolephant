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
            'resource "aws_nat_gateway"',
            'resource "aws_eip"',
            'resource "aws_db_instance"',
            'resource "aws_rds_cluster"',
            'resource "aws_eks_cluster"',
            'resource "aws_lb"',
        )
        for resource in forbidden_resources:
            self.assertNotIn(resource, main_tf, f"비용 사고 방지 위반 리소스 발견: {resource}")

        self.assertIn('billing_mode = "PAY_PER_REQUEST"', main_tf)
        self.assertIn("point_in_time_recovery", main_tf)
        self.assertIn('http_tokens   = "required"', main_tf)
        self.assertIn("encrypted   = true", main_tf)
        self.assertIn("block_public_acls       = true", main_tf)
        self.assertIn("restrict_public_buckets = true", main_tf)

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


if __name__ == "__main__":
    unittest.main()
