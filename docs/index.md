# 개발 문서 색인

제품 범위는 [PRD](../PRD.md), 처리 경계는 [ARCHITECTURE](../ARCHITECTURE.md), 작업 순서는 [내비게이터](../harness/NAVIGATOR.md)에서 확인합니다.

| 주제 | 문서 | 기준으로 삼는 내용 |
|---|---|---|
| 제품 | [범위와 사용자 여정](product/scope-and-journeys.md), [요구사항 추적](product/requirements.md) | 기능, 우선순위, 출처, 인수 조건 |
| 화면 | [화면 명세](ui/screens.md), [상태 전이](ui/state-machine.md) | 표시·입력·오류·복구 |
| 측정 | [신호 파이프라인](measurement/signal-pipeline.md), [판정 규칙](measurement/decision-rules.md) | 단위·보정·품질·결합 |
| 피드백 | [알림 정책](measurement/notifications.md) | 지속 시간·단계·쿨다운·교정 |
| 데이터 | [데이터 모델](data/model.md), [집계 정의](data/statistics.md) | 저장·중복·분모·시간대 |
| API | [HTTP 안내](api/README.md), [OpenAPI](api/openapi.json), [도우미 WebSocket](api/airpods-websocket.md) | 요청·응답·오류·메시지 |
| 보안 | [개인정보와 보안](security/privacy-and-security.md) | 전송 허용 목록·소유권·삭제 |
| 검증 | [인수 시나리오](quality/acceptance.md), [실측 계획](quality/measurement-validation.md) | 제품 동작과 측정 타당성 |
| 결정 | [미확정 목록](decisions/open-decisions.md), [브라우저 분석 결정 초안](decisions/adr-0001-browser-analysis.md) | 미정 사항과 변경 근거 |
| 출처 | [원문과 페이지 지도](references/README.md), [근거 목록](references/evidence-register.md) | 원문 위치·검증 상태 |

## 문서 상태의 뜻

- **원문 요구:** PDF에 명시된 제품 동작입니다. 연구 결과가 검증되었다는 뜻은 아닙니다.
- **설계 제안:** 문서 간 연결을 위해 추가한 계약·구조·예외 처리입니다. 팀 합의 전 초안입니다.
- **결정 대기:** `DEC-xxx`에서 선택과 이유를 기록해야 하는 항목입니다.
- **검증 대기:** 기기·카메라·브라우저 또는 기준 측정과 대조해야 하는 항목입니다.

충돌 시 출처와 결정 기록을 확인하고 문서를 함께 수정합니다. HTTP 필드 정의는 OpenAPI, 도우미 메시지는 JSON Schema, 숫자 시작값은 [예시 정책](../harness/fixtures/policy/example.json)이 단일 진입점입니다.

개발 운영 지식은 [하네스 지식 색인](../harness/docs/index.md)에 주제별로 있습니다.

- [개발·실행·구현 현황](development/index.md)
- [1차 MVP 스택 결정](decisions/adr-0002-first-mvp-stack.md)
