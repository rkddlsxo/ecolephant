# AWS 인프라 초안

**배포하지 않았습니다. Docker/DynamoDB·Cognito 실동작도 아직 검증하지 않았습니다.**
`cdk synth`는 검증했습니다 — `.github/workflows/ci-infra.yml`이 `infra/` 변경마다 `compileall`과 `cdk synth`를 실행합니다. 합성은 AWS API를 호출하지 않으므로 자격증명 없이 통과하며, 템플릿이 만들어진다는 것만 보장합니다. 실제 생성·동작 보장은 아닙니다.
첨부 클라우드 계획은 참고 자료이며 계정 발급·배포 지시로 취급하지 않았습니다.

## 준비한 구성

- CDK Python: 서울 리전, 태그, DynamoDB 온디맨드 단일 테이블, Flask Lambda, HTTP API, Cognito.
- Lambda는 VPC 없이 실행하며 로그 보관 14일과 오류 알람을 정의합니다.
- 논리적 세션·창·이벤트는 한 테이블의 pk/sk로 분리합니다. 정책은 현재 불변 배포 파일입니다.
- 세션 CAS와 배치 트랜잭션으로 동시 쓰기를 처리합니다. 삭제 tombstone 후 청크 정리 재시도가 가능합니다.
- 프론트는 사용자가 전달한 Amplify 구성을 우선 참고합니다. 별도 S3·CloudFront 리소스는 생성하지 않습니다.

## 후속 준비 순서

1. 담당자가 계정·IAM·예산·호스팅 방향과 보관 기간을 확정합니다.
2. `infra/cdk.json`의 frontendOrigin과 owner를 운영 값으로 바꿉니다.
3. 루트 `npm run lambda:package`로 Linux Python 3.12 패키지를 준비합니다.
4. 별도 Python 환경에 `infra/requirements.txt`를 설치하고 CDK CLI를 준비합니다.
5. infra에서 `cdk diff`를 확인한 뒤 승인된 계정에 배포합니다. (`cdk synth`는 CI가 이미 검사합니다.)
6. Cognito 로그인 UI, 실제 계정, Amplify의 API 주소·SPA rewrite를 연결합니다.

개발 토큰을 Amplify 환경 변수나 배포용 Secrets에 넣지 않습니다.
생성 설정만으로 운영 인증·비용·정합성 보장을 선언하지 않습니다.
[현재 상태](../docs/development/mvp-status.md) · [원본 클라우드 계획](../docs/references/cloud-plan.md).
