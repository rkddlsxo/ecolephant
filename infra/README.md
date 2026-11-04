# AWS 인프라 초안

**배포하지 않았습니다. Docker Compose·실제 AWS/Cognito 동작은 아직 검증하지 않았습니다.**
기존 main 브랜치의 CI에서 CDK CLI 2.1145.0 합성을 확인했습니다. 합성은 AWS 배포나 실제 동작 검증이 아닙니다.
첨부 클라우드 계획은 참고 자료이며 계정 발급·배포 지시로 취급하지 않았습니다.

## 준비한 구성

- CDK Python: 서울 리전, 태그, DynamoDB 온디맨드 단일 테이블, Flask Lambda, HTTP API, Cognito.
- Lambda는 VPC 없이 실행하며 로그 보관 14일과 오류 알람을 정의합니다.
- 논리적 세션·창·이벤트·불변 정책은 한 테이블의 pk/sk로 분리합니다. 배포 파일의 동일 ID 내용 변경은 거부됩니다.
- 세션 CAS와 배치 트랜잭션으로 동시 쓰기를 처리합니다. 삭제 tombstone 후 청크 정리 재시도가 가능합니다.
- DynamoDB Local 3.3.2 메모리 모드에서 API 수명주기·충돌·삭제를 검사했습니다. 실제 AWS 검증은 아닙니다.
- 가상 계정과 로컬 Lambda 패키지로 CDK Python 앱의 템플릿을 생성하고 인증·라우트·환경·권한을 검사했습니다. 실제 IAM 인수는 별도입니다.
- 현재 SRP 로그인에 불필요한 OAuth·기본 예시 콜백은 비활성화했습니다.
- 프론트는 사용자가 전달한 Amplify 구성을 우선 참고합니다. 별도 S3·CloudFront 리소스는 생성하지 않습니다.

## 후속 준비 순서

1. 담당자가 계정·IAM·예산·호스팅 방향과 보관 기간을 확정합니다.
2. `infra/cdk.json`의 frontendOrigin과 owner를 운영 값으로 바꿉니다.
3. 루트 `npm run lambda:package`로 Linux Python 3.12 패키지를 준비합니다.
4. 별도 Python 환경에 `infra/requirements.txt`를 설치하고 CDK CLI를 준비합니다.
5. infra에서 `cdk synth`, diff를 확인한 뒤 승인된 계정에 배포합니다.
6. Cognito 테스트 계정과 [프론트 인증 설정](../docs/development/authentication.md), Amplify API 주소·SPA rewrite를 연결하고 검증합니다.

현재 프론트 후보는 User Pool의 SRP 경로를 사용합니다. Cognito 관리형 로그인으로 결정한다면
OAuth를 별도 활성화하고 공개 클라이언트의 도메인·콜백·로그아웃 URL과 인증 코드 + PKCE 설정을 추가해 실계정으로 검증해야 합니다.
참고: [AWS PKCE 안내](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html).

개발 토큰을 Amplify 환경 변수나 배포용 Secrets에 넣지 않습니다.
생성 설정만으로 운영 인증·비용·정합성 보장을 선언하지 않습니다.
패키지는 임시 폴더에서 완성한 뒤 교체합니다. 이전 코드와 숨김 환경 파일·심볼릭 링크는 포함하지 않습니다.
기존 `.build/lambda`에 생성 표시가 없으면 자동으로 덮어쓰지 않습니다. 내용을 먼저 확인한 뒤 별도로 처리해야 합니다.
Linux 대상 패키지 생성은 확인했지만 해당 환경에서의 실제 실행과 배포는 검증하지 않았습니다.
[현재 상태](../docs/development/mvp-status.md) · [원본 클라우드 계획](../docs/references/cloud-plan.md).
