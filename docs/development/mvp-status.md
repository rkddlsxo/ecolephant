# 1차 MVP 구현 현황

기준일: 2026-10-17 · 범위: 사용자 지정 스택을 사용한 **합성 입력 로컬 MVP**.
코드 구현과 빌드 확인을 실제 장치·사용자 시나리오 검증과 구분합니다.

## 구현한 부분

| 영역 | 들어간 기능 | 위치 |
|---|---|---|
| 프론트 | 준비·방식 선택·데모 기준 설정·동의 폼 | [준비 화면](../../frontend/src/pages/PreparePage.tsx) |
| 실시간 | 모드·신호·판정·일시정지·재설정·종료 저장·전송 대기 | [측정](../../frontend/src/pages/MeasurePage.tsx), [수명주기](../../frontend/src/features/measurement/controller.ts) |
| 기록 | 기간·방식 필터, 세션/이벤트 페이지 처리, 상세·타임라인·내보내기·삭제 | [기록](../../frontend/src/pages/HistoryPage.tsx), [상세](../../frontend/src/pages/SessionPage.tsx) |
| UI | Radix 설정·삭제 창, 카드 순서 변경, Motion 전환, 반응형 | [컴포넌트](../../frontend/src/components), [스타일](../../frontend/src/styles.css) |
| 카메라 | 명시적 버튼으로 켜는 로컬 미리보기, 종료·탭 숨김 때 해제 | [미리보기](../../frontend/src/components/CameraPreview.tsx) |
| 분석 | 합성 관측값, 단일/결합 판정, 누락·품질 구분 | [ai](../../ai/src) |
| 알림 | 지속·1/2차·쿨다운·화면 전달 확인·교정/미확인 기록 | [분석 상태](../../ai/src/alerts.ts), [실행](../../frontend/src/features/measurement/controller.ts) |
| 백엔드 | OpenAPI의 12개 동작, 요청 검증·소유자·멱등성·연속성·종료 충돌 | [Flask](../../backend/ecolephant) |
| 저장·집계 | SQLite 영속 저장, 승인 창 기반 시간 가중·방식별·기간·시간대 통계 | [저장](../../backend/ecolephant/storage.py), [집계](../../backend/ecolephant/metrics.py) |
| 개발 | 루트 npm workspace·잠금 파일, Python 제약 파일, setup/dev, API 타입 생성, 린트·포맷·커밋 훅 | [scripts](../../scripts), [package](../../package.json) |
| 하네스 | 실행 스택·계획·현황 연결, 빌드/환경 파일 제외, 문서 목록 갱신 | [NAVIGATOR](../../harness/NAVIGATOR.md) |

이 표의 ‘구현’은 코드가 있다는 의미입니다. 인수 시나리오를 실행해 passed로 판정했다는 의미는 아닙니다.
전송 큐는 600개 창 한도이며 한도 이후 상세 입력을 중단합니다. 복구 후 빠진 시간은 판단 불가로 채우며 새로고침 후 큐 복원은 지원하지 않습니다.

## 코드·설정만 준비한 부분

- DynamoDB Local/AWS 저장 어댑터, Flask Lambda 핸들러, Cognito JWT 검증 경로.
- Compose 로컬 대안, CDK Python 인프라, Amplify 모노레포 빌드 설정, 합성 입력 업로드 CLI.
- CI는 Flask·Node 22·TypeScript 기준으로 변경했습니다. 호스팅된 실행 결과는 별도 확인 대상입니다.
- Vitest·Testing Library 환경은 준비했으며 제품 테스트는 추가하거나 실행하지 않았습니다.

## 아직 안 된 부분

1. **실제 웹캠 자세 추정:** 모델·관절점 추출·검증된 각도 매핑·사용자별 실제 보정.
2. **AirPods 실연동:** Mac 도우미·호환 모델·축 정의·페어링·시각 정렬·실제 장애 복구.
3. **실센서 통합 검증:** 정확도, 개인정보 네트워크 확인, 브라우저·절전·탭 복구·오프라인 시나리오.
4. **운영 로그인·배포:** Cognito 로그인 화면·발급 계정·AWS 권한·배포·도메인·Amplify rewrite·운영 모니터링 알림 수신처.
5. **클라우드 검증:** Docker/DynamoDB 실행, CDK synth, Lambda Linux 패키지/운영 API 확인은 미수행.
6. **디자인 시스템 패키지:** GitHub Packages의 정확한 이름·버전·접근 권한이 필요합니다.
7. **시스템 알림·소리:** 현재는 화면 알림만 구현했습니다.
8. **운영 정책:** 실제 수치 승인, 기록 보관 기간, 삭제 식별자 정리 주기, active 자동 만료, 비정상 종료 후 큐 복원.

## 수행한 확인

최종 실행 결과는 아래 표에 기록합니다. 자동 제품 테스트·브라우저 시나리오·실측·실배포를 완료했다고 표시하지 않습니다.

| 확인 | 결과 |
|---|---|
| Node 22 프론트/ai 타입·배포 빌드 | 통과 · Node 22.23.3 / TypeScript 5.9.3 / Vite 8.3.4 |
| ESLint · Python Ruff | 통과 · frontend/ai 및 backend/infra/CLI. Python 구문 컴파일 통과 |
| OpenAPI 생성 타입·복사본 일치 | 통과 · contracts:check |
| 하네스 문서·링크·구조·비밀정보 정적 검사 | 통과 · 문서 112개, 로컬 링크 498개, 제품 소스 35개. 계약 fixture·회귀 테스트는 미실행 |
| 제품 단위·통합·브라우저·장치 테스트 | 미실행 |
| AWS 배포·운영 검증 | 미실행 |

## 다음 우선순위

실제 입력과 AI 스택 선택 → 웹캠 어댑터/실측 → AirPods 범위 결정 → 계약·수명주기 검증 → 로그인·클라우드 통합.
[실행 안내](local.md) · [후속 계획](../../harness/docs/plans/active/sensor-and-cloud.md) · [결정 목록](../decisions/open-decisions.md).
