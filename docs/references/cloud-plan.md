# 클라우드·인프라 작업 계획 (ecolephant 기준)

> 기준 저장소: [rkddlsxo/ecolephant](https://github.com/rkddlsxo/ecolephant) — `PRD.md`, `ARCHITECTURE.md`, `docs/api/openapi.json`, `docs/data/model.md`, `docs/decisions/adr-0001-browser-analysis.md`
> 작성: 2026-10-17 (7주차) · 원안 `CLOUD_PLAN.md`를 실제 저장소 구조·스택에 맞춰 개정
> 리전: `ap-northeast-2`(서울) · AWS 접근: **사업단 제공 IAM User — 미발급 상태**

## 0. 원안에서 바뀐 점

원안 `CLOUD_PLAN.md`는 "스마트 의자" 단계의 계획이라 현재 저장소와 맞지 않는 부분이 있습니다. 아래 기준으로 개정했습니다.

| 항목 | 원안 (CLOUD_PLAN.md) | 개정 (ecolephant 기준) | 근거 |
|---|---|---|---|
| 저장소 구조 | `apps/mobile` `packages/*` `services/api` `infra` `tools/simulator` | **`ai/` `backend/` `frontend/`** + `docs/` `harness/` 유지, `infra/` `tools/simulator/` 추가 | 현 저장소 구조 |
| 클라이언트 | React Native 모바일 앱 | **웹 브라우저** | ADR-0001, PRD "자세 측정 웹 MVP" |
| 백엔드 | Lambda **Node.js + TypeScript** | **Flask (Python 3.12)** | 팀 결정 (2026-10-17) |
| 분석 모듈 | 항목 없음 | `ai/` = **브라우저 실행 모듈**, 서버 아님 | ADR-0001 |
| 공유 집계 모듈 | TS 패키지 하나를 앱·Lambda가 공유 | **언어가 갈림** → 2절 A-4에서 별도 처리 | Flask(py) + 브라우저(js) |
| API 계약 | 작성 예정 | **이미 확정** — `docs/api/openapi.json` 10개 엔드포인트 | 저장소 |
| 업로드 흐름 | S3 Presigned URL로 이벤트 로그 업로드 | **MVP에서 제외** — 파생 결과만 API로 전송 | ADR-0001 (원시 데이터 서버 전송 금지) |
| IaC | AWS CDK (TypeScript) | **AWS CDK (Python)** | 백엔드와 언어 통일 |

**원안에서 그대로 가져가는 것**: 리전·태그 규칙, 서버리스 기본안 / EC2 대체안 2트랙, 비용 사고 방지 규칙(NAT·RDS·REST API v1 금지), 시뮬레이터 우선 전략, 크레딧 산정 방식.

## 1. 목표 아키텍처

```
[브라우저]
  frontend/ (웹 UI)
  ai/ (분석 모듈 — 번들에 포함, 네트워크 접근 없음)
        │  파생 결과만 전송 (각도·판정·품질·시간)
        ▼
  API Gateway HTTP API ──(JWT)── Cognito
        │
  Lambda : backend/ Flask app (apig-wsgi 어댑터)
        │
  DynamoDB : Sessions / SampleWindows / Events / Policies
```

영상·관절점·원시 IMU는 서버로 가지 않습니다(ADR-0001). `ai/`는 별도 서버가 아니므로 **인프라 비용 0**이고 CI에서 번들 빌드·테스트만 합니다.

### 저장소 배치

```
ecolephant/
├── ai/               # 브라우저 분석 모듈 (JS/TS) — 서버 없음
├── backend/          # Flask 앱 + Lambda 핸들러
├── frontend/         # 웹 UI (정적 빌드 산출물)
├── infra/            # AWS CDK (Python) 스택            ← 신규
├── tools/simulator/  # 세션·창·이벤트 생성기 + 업로드 CLI  ← 신규
├── docs/             # 기존 문서 (OpenAPI가 API 기준)
└── harness/          # 기존 문서·계약 검사
```

### 기술 선택 근거

| 결정 | 선택 | 이유 |
|---|---|---|
| Flask를 Lambda에 올리는 법 | `apig-wsgi` 또는 AWS Lambda Web Adapter | Flask는 WSGI라 Mangum(ASGI) 사용 불가. 어댑터 한 겹이면 로컬에선 평범한 Flask로 실행 |
| DB | DynamoDB 온디맨드 | `session_id + seq` 유일성을 조건부 쓰기(`attribute_not_exists`)로 처리 → 배치 재전송 멱등성이 깔끔. RDS는 상시 과금이라 제외 |
| 프런트 호스팅 | S3 + CloudFront (OAC) | 정적 번들, 월 $1 미만 |
| IaC | CDK (Python) | 백엔드와 언어 통일. Lambda+HTTP API 조합은 Terraform보다 보일러플레이트가 적음 |
| 인증 | Cognito User Pool + HTTP API JWT authorizer | 10,000 MAU까지 무료. DEC-005 확정 전까진 테스트 계정만 |

## 2. 두 가지 트랙

IAM 계정이 없으므로 **트랙 A부터 시작**하고, 계정이 나오면 트랙 B로 넘어갑니다. 트랙 A 산출물은 버리지 않고 그대로 재사용합니다.

---

### 트랙 A — IAM 계정이 없을 때 (지금 ~ 발급 전)

AWS 없이도 전체의 70%는 진행됩니다. 핵심은 **로컬에서 서버를 완성해 두고, 계정이 나오면 배포만 남기는 상태**를 만드는 것입니다.

#### A-1. 로컬 실행 환경
- [ ] `backend/` Flask 앱 스캐폴드 — OpenAPI 10개 엔드포인트 라우트 뼈대
- [ ] `docker-compose.yml`: Flask + **DynamoDB Local**(`amazon/dynamodb-local`)
- [ ] 저장 계층 추상화 — 로컬은 DynamoDB Local, 배포는 DynamoDB (엔드포인트만 교체)
- [ ] `.env.example` (`AWS_ENDPOINT_URL`, `TABLE_PREFIX` 등)

```bash
docker compose up -d        # DynamoDB Local + Flask
curl localhost:5000/health  # {"status":"ok"}
```

#### A-2. 계약 준수 검증 (AWS 불필요)
- [ ] `docs/api/openapi.json` 기준 응답 스키마 검증 테스트
- [ ] 모델 제약 테스트: `session_id+seq` 중복 거부, 창 연속성(`prev.start + duration == next.start`), 종료 시 누락 → **409**, `final_seq=0`은 빈 세션만, 저장된 최대 seq보다 작은 `final_seq` 거부
- [ ] 배치 순서 뒤바뀜 처리 — 가장 긴 연속 seq 반환
- [ ] 금지 필드(영상·관절점·원시 IMU) 전송 시 거부

#### A-3. 시뮬레이터 (원안 F 유지)
- [ ] 시나리오 → 창·이벤트 생성 (예: 바른 자세 5분 → 거북목 40초 → 복귀 → 센서 끊김 20초)
- [ ] 생성 로그를 로컬 API로 업로드하는 CLI
- [ ] 시나리오와 **기대 보고서 값**을 쌍으로 저장 → 집계 회귀 테스트로 재사용

#### A-4. 집계 모듈 (원안 E의 대체안)

원안은 "TS 패키지 하나를 앱과 Lambda가 공유"였지만 이제 브라우저(JS)와 서버(Python)로 언어가 갈립니다.

| 안 | 내용 | 평가 |
|---|---|---|
| 1 | 서버(Python)만 집계, 브라우저는 실시간 판정만 | **권장.** 중복 구현 없음, 보고서는 서버 책임 |
| 2 | 양쪽 각각 구현 + 공통 테스트 벡터(JSON)로 동치 검증 | 브라우저에서 즉시 보고서가 필요할 때만 |
| 3 | WASM 등 공통 엔진 | 학기 일정에 과함 |

- [ ] 안 1로 진행, 단 **테스트 벡터 JSON은 지금 작성** (PRD 8절 완료 기준 사례 = A-3 시나리오와 공유)
- [ ] 경계 사례: 최소 지속 시간 미만/이상, 복귀 확인 시간 미만/이상, 센서 누락 중 발생 닫기, 재보정 구간 제외, 동시 발생 중복 제거, 분모 0 → "산출 불가", 알림 실패·보류·중복 제외

#### A-5. IaC 선행 작성
- [ ] `infra/` CDK(Python) 스택 — DynamoDB, Lambda, HTTP API, Cognito
- [ ] **`cdk synth`는 자격증명 없이 실행 가능** → CI에서 합성 성공 여부만 검사
- [ ] `cdk bootstrap` / `cdk deploy`는 계정 발급 후

#### A-6. CI 확장 (이미 머지된 3종 위에)

| 워크플로 | 현재 | 트랙 A에서 할 일 |
|---|---|---|
| `ci-backend.yml` | Python 3.12 + ruff + pytest (가드 상태) | 가드 제거, DynamoDB Local 서비스 컨테이너로 통합 테스트, 계약 검증 |
| `ci-frontend.yml` | Node 20 + lint/build | 액션 버전 v7 통일, `permissions` 추가 |
| `ci-ai.yml` | **Python 기준 — 수정 필요** | 브라우저 모듈이면 Node 기준으로 교체 |
| `ci-infra.yml` (신규) | — | `cdk synth` 검사 |
| `harness.yml` | 팀 소유 | 건드리지 않음 |

- [ ] main 브랜치 보호 + required status checks 등록

#### A-7. 계정 발급 준비
- [ ] 사업단에 **필요 권한 목록** 정리해 요청 (B-1 액션 목록)
- [ ] 크레딧 신청액 확정 — 서버리스 $50 / EC2 대체안 $100 (4절)

---

### 트랙 B — IAM 계정을 받은 뒤

#### B-1. 권한 확인 (받은 날 즉시)

```bash
aws sts get-caller-identity
aws iam list-attached-user-policies --user-name <IAM유저명>
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::<계정ID>:user/<IAM유저명> \
  --action-names iam:CreateRole iam:PassRole cloudformation:CreateStack \
    lambda:CreateFunction apigateway:POST dynamodb:CreateTable \
    s3:CreateBucket cognito-idp:CreateUserPool budgets:ModifyBudget \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output table
```

| 결과 | 진행 방식 |
|---|---|
| `iam:CreateRole` · `iam:PassRole` · `cloudformation:*` 허용 | **서버리스 + CDK** (기본안) |
| 위 거부, EC2 허용 | **EC2 단일 서버 + Docker** (대체안) |
| 둘 다 애매 | 권한 목록 정리해 사업단에 요청 |

- [ ] 리전 `ap-northeast-2` 고정, 전 리소스에 태그 `Project=ecolephant`, `Owner=<이름>`
- [ ] AWS Budgets 비용 알림 (권한 없으면 사업단에 요청)
- [ ] **액세스 키는 로컬 프로필로만** — 저장소에 절대 커밋 금지

#### B-2. 기본안 — 서버리스 배포

| 순서 | 리소스 | 설정 포인트 |
|---|---|---|
| 1 | DynamoDB `Sessions` `SampleWindows` `Events` `Policies` | 온디맨드. 키 설계는 `docs/data/model.md`, 중복은 조건부 쓰기로 거부 |
| 2 | Lambda (Python 3.12, Flask + `apig-wsgi`) | **VPC 밖 배치**(NAT 비용 방지), 로그 보관 14일 |
| 3 | API Gateway **HTTP API** | REST API(v1)보다 저렴, Cognito JWT authorizer |
| 4 | Cognito User Pool | Lite/Essentials, 팀·시연 계정만 |
| 5 | S3 + CloudFront | `frontend/` 정적 번들, 퍼블릭 차단 + OAC |

```bash
cd infra
cdk bootstrap aws://<계정ID>/ap-northeast-2 --profile <프로필>
cdk deploy --profile <프로필>
```

#### B-3. 대체안 — EC2 (role 생성 권한이 없을 때)
- [ ] t4g.small 1대 + Docker Compose (gunicorn + Flask, nginx)
- [ ] DynamoDB는 그대로 사용 (인스턴스 프로파일 불가 시 액세스 키를 환경변수로)
- [ ] **시연 기간 외 인스턴스 중지**, 탄력적 IP 방치 금지

#### B-4. 배포 파이프라인
- [ ] `.github/workflows/deploy.yml` — main 머지 시 `cdk deploy`
  - role 생성 권한 있음 → **OIDC**(`id-token: write`, 키 없음)
  - 없음 → 액세스 키를 GitHub Secrets에 저장 + 주기적 교체
- [ ] PR에서는 `cdk diff`만, apply는 main 한정 (fork PR에서 배포 금지)
- [ ] GitHub Environment `production` + 승인 게이트

#### B-5. 운영
- [ ] CloudWatch 알람 — Lambda 오류율, API 5xx
- [ ] 로그 보관 14일 고정
- [ ] 비용 대시보드 주 1회 확인
- [ ] 세션 삭제 API가 창·이벤트·집계 캐시까지 지우는지 실환경 확인 (DEC-006)

## 3. 도구별 도입 여부

학기 프로젝트 규모(사용자 10여 명, 세션 300~500회, 크레딧 $50)와 "브라우저 분석 + 얇은 저장 API"라는 구조를 기준으로 판단했습니다.

| 도구 | 필요 | 판단 |
|---|---|---|
| **IaC** (CDK Python) | ⭕ **필요** | 리소스가 6종이면 콘솔 클릭으로는 재현이 안 됩니다. 프로그램 등록용 소스에 인프라 코드가 포함되고(H 항목), 학기 말 리소스 정리도 `cdk destroy` 한 줄로 끝납니다 |
| **CI/CD** (GitHub Actions) | ⭕ **필요 · 이미 구축** | CI 3종 머지 완료. 남은 건 `cdk synth` 검사와 배포 워크플로 |
| **Docker** | 🔸 **로컬 개발용만** | `docker-compose`로 Flask + DynamoDB Local을 띄우는 용도는 가치 있음. 단 **Lambda 배포에는 컨테이너 이미지가 불필요**합니다(zip 패키지가 더 빠르고 쌈). EC2 대체안으로 가면 그때 배포용으로도 사용 |
| **Kubernetes** | ❌ **불필요** | 아래 설명 |
| **GitOps · ArgoCD** | ❌ **불필요** | 아래 설명 |
| **Helm** | ❌ 불필요 | K8s를 안 쓰므로 해당 없음 |
| **모니터링** (CloudWatch) | ⭕ 필요 | 별도 스택(Prometheus/Grafana) 없이 CloudWatch 기본 지표·알람으로 충분 |

### Kubernetes를 쓰지 않는 이유

| 근거 | 내용 |
|---|---|
| **비용** | EKS는 컨트롤 플레인만 시간당 $0.10 = **월 약 $73**. 워커 노드는 별도. 크레딧 $50을 **첫 달에 초과**합니다. 직접 구축(k3s on EC2)해도 월 $20 + 운영 부담 |
| **부하** | 트래픽이 세션당 API 호출 5~10회 수준입니다. Lambda 프리 티어 범위 안이고, 오토스케일링·롤링 업데이트가 해결할 문제 자체가 없습니다 |
| **운영 인원** | 클라우드 담당 1명이 API·집계·시뮬레이터·발표자료까지 맡습니다. 클러스터 유지보수에 쓸 시간이 일정표에 없습니다 |
| **단일 서비스** | 배포 대상이 Flask 앱 하나입니다. 오케스트레이션할 서비스가 여러 개가 아닙니다 |

### GitOps / ArgoCD를 쓰지 않는 이유

| 근거 | 내용 |
|---|---|
| **전제 조건 부재** | ArgoCD는 **쿠버네티스 클러스터 안에서 동작**합니다. 클러스터가 없으면 설치 자체가 불가능합니다 |
| **상시 과금** | ArgoCD 자체가 파드로 24시간 떠 있어야 합니다. 월 몇 달러짜리 서버리스 구조에 상시 컨트롤러를 띄우는 건 배보다 배꼽 |
| **대체 수단으로 충분** | GitOps의 본질인 "Git을 단일 진실 공급원으로 두고 선언적 상태를 동기화"는 **CDK 코드 + main 머지 시 `cdk deploy`** 로도 달성됩니다. PR에 `cdk diff`를 붙이면 변경 리뷰까지 동일하게 확보 |
| **드리프트 감지** | ArgoCD의 강점인 드리프트 감지는 CloudFormation **drift detection**이나 CI의 주기적 `cdk diff`로 대체 가능 |

> **단, 학습·포트폴리오 목적이라면** 이야기가 다릅니다. 다만 그 경우에도 이 과제의 운영 환경이 아니라 **별도 저장소에서 k3s + ArgoCD를 따로 실습**하는 쪽을 권합니다. 시연용 인프라에 K8s를 끼워 넣으면 비용 초과와 발표회 당일 장애 위험을 동시에 떠안습니다.

### 결론: 이 프로젝트의 최소 충분 구성

```
GitHub (단일 진실 공급원)
  └ GitHub Actions
       ├ PR   : lint · test · 계약 검증 · cdk diff
       └ main : cdk deploy → AWS (Lambda · HTTP API · DynamoDB · S3+CloudFront)
  Docker는 로컬 개발(docker-compose)에만 사용
```

## 4. 비용

영상·원시 데이터를 서버에 올리지 않으므로 원안보다 저장 비용이 더 내려갑니다.

| 서비스 | 예상 월 비용 |
|---|---|
| API Gateway HTTP API | $0.01 미만 |
| Lambda | $0.1 미만 |
| DynamoDB 온디맨드 | $0.1 미만 |
| S3 + CloudFront (정적 번들) | $0.5 미만 |
| Cognito | $0 (10,000 MAU 무료) |
| CloudWatch Logs (14일 보관) | $0.5 ~ 2 |
| **합계** | **월 $1 ~ 3** |

**요청 크레딧: 서버리스 $50 / EC2 대체안 $100** — 실사용은 $10 안팎 예상이나 남은 리소스·로그 폭증 대비 여유분. 사업단 계정의 프리 티어 적용 여부가 불명이라 프리 티어 없이 산정했습니다.

**비용 사고 방지**: NAT Gateway 금지(Lambda를 VPC 밖에), RDS 금지(DynamoDB로 충분), REST API v1 대신 HTTP API, EC2·탄력적 IP 방치 금지, 로그 무제한 보관 금지, **EKS 금지**(3절).

## 5. 남은 일정 (7주차 ~ 16주차)

| 주차 | 기간 | 트랙 A (IAM 없어도 가능) | 트랙 B (IAM 받은 뒤) |
|---|---|---|---|
| 7 | 10.12~10.18 | CI 정비, Flask 스캐폴드, docker-compose | 권한 확인·비용 알림 |
| 8 | 10.19~10.25 | 세션·배치 API 구현, 계약 테스트, 시뮬레이터 착수 | CDK bootstrap, DynamoDB·Lambda·HTTP API 첫 배포 |
| 9 | 10.26~11.1 | 집계 모듈 + 테스트 벡터 | Cognito, 인증 연동 |
| 10 | 11.2~11.8 | 프런트 업로드·재시도 연동, 삭제 API | S3+CloudFront 배포, deploy 워크플로 |
| 11 | 11.9~11.15 | 통합 테스트 | CloudWatch 알람, 로그 보관 |
| 12 | 11.16~11.22 | 버그 수정, **현장 네트워크 없이 시연되는지 확인** | 비용 점검 |
| 13~14 | 11.23~12.6 | 아키텍처 다이어그램·비용 결과 (발표자료 마감 12.7) | |
| 15 | 12.7~12.13 | 리허설, 리소스 변경 동결, 등록용 소스 정리 | |
| 16 | 12.14~12.18 | 발표회 12.15 지원(핫스팟), 등록·IOSS 12.18 | |

IAM 발급이 11월로 밀려도 트랙 A만으로 8~10주차 작업이 가능하고, 배포는 1~2일이면 따라잡습니다. 다만 **12주차(11.22) 전에는 실배포가 한 번 돌아야** 시연 리스크가 없습니다. 이 날짜가 사실상의 데드라인입니다.

## 6. 위험 요소

| 위험 | 대응 |
|---|---|
| IAM 계정 발급 지연 | 트랙 A로 선행, 11.22를 배포 데드라인으로 고정 |
| 권한 부족으로 서버리스 불가 | 받는 즉시 B-1 시뮬레이션, 안 되면 EC2 대체안 |
| 브라우저·서버 집계 불일치 | 집계는 서버 단일 구현(A-4 안 1), 테스트 벡터로 고정 |
| 스택이 DEC-008 미결정 상태 | Flask 결정을 결정 템플릿으로 기록하고 DEC-008 닫기 |
| 발표회 현장 네트워크 불안정 | 판정·알림·로컬 보기는 오프라인 동작 유지, 핫스팟 준비 |
| 스키마 변경으로 이전 로그 해석 불가 | `schemaVersion` / `policy_id` 유지, 정책 변경 시 새 ID |

## 7. 먼저 처리할 결정

| ID | 내용 | 상태 |
|---|---|---|
| DEC-008 | 기술 스택과 배포 | backend=Flask 확정(10.17). **ai/frontend 스택·DB·호스팅은 미기록** → 결정 템플릿으로 남길 것 |
| DEC-005 | 인증과 기록 소유자 | Cognito 전제로 설계 중, 발급 방식 미정 |
| DEC-006 | 기록 보관과 삭제 | 로그 보관 14일은 확정, 파생 결과 보관 기간 미정 |
