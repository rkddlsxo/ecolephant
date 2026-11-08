# 클라우드 배포 절차 및 장애 대응 매뉴얼 (Runbook)

본 문서는 [아키텍처](../../ARCHITECTURE.md)와 [로컬 실행 안내](../development/local.md)를 기준으로 AWS 계정 발급 후 배포 순서, 필요 IAM 권한, 비용 산정 근거, 장애 대응 절차를 정리합니다.

## 1. 운영 아키텍처 개요

```mermaid
flowchart LR
    Browser["브라우저 (frontend + ai 로컬 분석)"] -->|HTTPS 정적 자산| CF["CloudFront + S3 (OAC)"]
    Browser -->|파생 결과 JSON (원본 영상·관절점 제외)| Nginx["EC2 Nginx 리버스 프록시"]
    Nginx -->|proxy_next_upstream| B1["backend 컨테이너 #1"]
    Nginx -->|proxy_next_upstream| B2["backend 컨테이너 #2"]
    B1 -->|IAM Instance Profile| DDB[("DynamoDB 단일 테이블")]
    B2 -->|IAM Instance Profile| DDB
    Alloy["Grafana Alloy (unix + cadvisor + loki)"] -->|메트릭·JSON 로그| Obs["Prometheus + Loki + Grafana"]
```

## 2. 사업단 제출용 필요 IAM 권한 및 예산 근거

### 최소 권한 목록
- IAM OIDC 부트스트랩: `iam:CreateOpenIDConnectProvider`, `iam:CreateRole`, `iam:PutRolePolicy`, `iam:PassRole` (`arn:aws:iam::*:role/ecolephant-*` 범위)
- 컴퓨팅 및 네트워크: `ec2:*` (`ap-northeast-2` 리전 `t4g.small` 1대 및 보안 그룹)
- 데이터 저장소 및 인증: `dynamodb:*` (`ecolephant-results` 온디맨드 단일 테이블), `cognito-idp:*`
- 정적 호스팅 및 관측: `s3:*`, `cloudfront:*`, `cloudwatch:*`, `logs:*`, `sns:*`

### 예상 비용 및 사고 방지 규칙
- DynamoDB 온디맨드 + S3/CloudFront 정적 번들 + CloudWatch/Loki 14일 보관: 월 \$1 ~ \$3 수준 (EC2 `t4g.small` 시연 기간 가동 포함 시 신청 크레딧 \$50 ~ \$100 이내)
- 비용 사고 방지: NAT Gateway 미사용, RDS 미사용, EKS 미사용, 로그 보관 14일(`336h`) 고정, 발표 종료 후 `terraform destroy` 실행

## 3. GitHub Variables 및 Secrets 분리 규칙

| 구분 | 이름 | 용도 |
|---|---|---|
| Variables | `AWS_ROLE_ARN` | `infra/terraform/oidc/outputs.tf`가 출력한 배포용 IAM Role ARN |
| Variables | `AWS_REGION` | 기본값 `ap-northeast-2` |
| Variables | `EC2_HOST` | `infra/terraform/main/outputs.tf`가 출력한 EC2 공인 IP |
| Variables | `EC2_USER` | 기본값 `ubuntu` |
| Secrets | `EC2_SSH_KEY` | Ansible 접속용 SSH 개인키 |

## 4. Phase 2 배포 순서 (AWS 계정 발급 후)

1. `aws sts get-caller-identity`로 계정 및 리전(`ap-northeast-2`)을 확인합니다.
2. `infra/terraform/oidc`에서 `terraform init && terraform apply`를 실행하고 출력된 `deploy_role_arn`을 GitHub Variables `AWS_ROLE_ARN`에 등록합니다.
3. `infra/terraform/main`에서 `terraform init && terraform apply`로 EC2, DynamoDB, Cognito, CloudFront를 생성합니다.
4. `EC2_HOST` Variable과 `EC2_SSH_KEY` Secret을 등록하면 `main` 브랜치 반영 시 [배포 워크플로](../../.github/workflows/deploy.yml)가 자동으로 `infra/ansible/playbook.yml`을 실행합니다.

## 5. 장애 대응 및 복구 절차 (Runbook)

### 시나리오 A: 배포 중 컨테이너 헬스체크 실패
- 증상: 롤링 업데이트 스크립트에서 신규 컨테이너가 30초 내 `healthy`에 도달하지 못함.
- 자동 보호: 스크립트가 즉시 중단(`exit 1`)되며, 구버전 컨테이너 2개가 그대로 트래픽을 처리하므로 서비스 중단이 발생하지 않습니다.
- 조치: `docker compose logs --tail=100 backend` 또는 Grafana Loki(`{service="backend"}`)에서 최근 에러 로그를 확인합니다.

### 시나리오 B: 백엔드 1개 컨테이너 비정상 응답 (502/503/Timeout)
- 자동 보호: Nginx의 `max_fails=2 fail_timeout=5s` 및 `proxy_next_upstream` 설정이 해당 컨테이너를 5초간 제외하고 나머지 정상 컨테이너로 요청을 재시도합니다.
- 조치: `sudo systemctl reload ecolephant`로 롤링 교체를 수행하거나 컨테이너 상태를 점검합니다.

### 시나리오 C: 학기/발표 종료 후 전체 리소스 정리 (비용 0원 확인)
1. `infra/terraform/main`에서 `terraform destroy`를 실행해 EC2, CloudFront, S3, DynamoDB, Cognito, 알람을 일괄 삭제합니다.
2. `infra/terraform/oidc`에서 `terraform destroy`를 실행해 OIDC Role을 삭제합니다.
3. AWS Billing 콘솔에서 활성 리소스와 잔여 비용이 0인지 최종 확인합니다.
