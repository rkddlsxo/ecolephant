"""AWS 실서버 배포 전 안전 점검(Preflight Check) 스크립트
   다른 리전(미국)에 배포하거나, 금지된 서비스를 생성하는 사고를 배포 전에 차단
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_REGION = "ap-northeast-2"
REQUIRED_PROFILE = "SafeInstanceProfile-inha-capstone-20"
REQUIRED_LAMBDA_ROLE = "SafeRole-inha-capstone-20"
REQUIRED_S3_PREFIX = "inha-capstone-20"
ALLOWED_EC2_TYPES = ("t3.nano", "t3.micro", "t3.small", "t3.medium")
FORBIDDEN_RESOURCES = (
    "aws_route53_zone",
    "aws_route53_record",
    "aws_acm_certificate",
    "aws_nat_gateway",
    "aws_eks_cluster",
)


def verify_aws_capstone_readiness(
    region=REQUIRED_REGION,
    instance_profile=REQUIRED_PROFILE,
    instance_type="t3.medium",
    s3_bucket_name="inha-capstone-20-ecolephant-frontend",
):
    if region != REQUIRED_REGION:
        raise ValueError(f"허용되지 않은 AWS 리전입니다: {region} (필수: {REQUIRED_REGION})")
    if instance_profile != REQUIRED_PROFILE:
        raise ValueError("사전 지급된 SafeInstanceProfile을 사용해야 합니다.")
    if instance_type not in ALLOWED_EC2_TYPES:
        raise ValueError(f"허용되지 않은 EC2 인스턴스 타입입니다: {instance_type} (허용: t3.nano ~ t3.medium)")
    if not s3_bucket_name.startswith(REQUIRED_S3_PREFIX):
        raise ValueError(f"S3 버킷 이름은 반드시 {REQUIRED_S3_PREFIX}로 시작해야 합니다: {s3_bucket_name}")

    main_tf = (ROOT / "infra" / "terraform" / "main" / "main.tf").read_text(encoding="utf-8")
    for forbidden in FORBIDDEN_RESOURCES:
        if f'resource "{forbidden}"' in main_tf:
            raise ValueError(f"캡스톤 지원 불가 리소스가 포함되어 있습니다: {forbidden}")

    return {
        "ready": True,
        "region": region,
        "instance_profile": instance_profile,
        "instance_type": instance_type,
        "s3_bucket_name": s3_bucket_name,
    }


if __name__ == "__main__":
    print(verify_aws_capstone_readiness())
