# 요구사항과 추적 기준

원문 페이지는 [사용자 제공 PDF](../references/README.md)를 가리킵니다. 우선순위와 출시 범위는 [PRD](../../PRD.md)를 따릅니다. 상세 인수 조건은 [시나리오 목록](../quality/acceptance.md), 기계가 검사하는 연결은 [추적표](traceability.json)입니다.

| ID | 요구사항 | 상태 | 담당 경계 | 원문 쪽 |
|---|---|---|---|---|
| REQ-001 | [노트북 웹의 준비·실시간·기록 흐름](../ui/screens.md) | 원문 | frontend | 1, 4, 5, 6, 7, 8 |
| REQ-002 | [세 가지 측정 방식과 품질 기반 자동 전환](../ui/state-machine.md) | 원문+설계 제안 | frontend/ai | 2, 3 |
| REQ-003 | [영상·관절점·원시 센서의 서버 전송 금지](../security/privacy-and-security.md) | 원문+확장 | 전체 | 1, 3, 4 |
| REQ-004 | [기준 자세 보정·실패·재보정](../measurement/signal-pipeline.md) | 원문+설계 제안 | frontend/ai | 2, 5 |
| REQ-005 | [웹캠 특징과 검증된 각도 매핑 분리](../measurement/signal-pipeline.md) | 원문+설계 제안 | ai | 1, 3, 9, 10 |
| REQ-006 | [AirPods 도우미 연결과 메시지 계약](../api/airpods-websocket.md) | 원문+설계 제안 | frontend/helper | 3, 4, 9 |
| REQ-007 | [시간 정렬·인식 품질·움직임 구간 처리](../measurement/signal-pipeline.md) | 원문+설계 제안 | ai | 2, 3, 9 |
| REQ-008 | [센서별 값·종합값·판정 이유의 일관성](../measurement/decision-rules.md) | 원문+설계 제안 | ai/frontend | 1, 2, 6, 7 |
| REQ-009 | [센서별 값과 품질을 색·숫자·문구로 표시](../ui/screens.md) | 원문 | frontend | 4, 6, 7 |
| REQ-010 | [측정 중 정지·재개·재보정·종료](../ui/state-machine.md) | 원문+설계 제안 | frontend/backend | 6, 7 |
| REQ-011 | [최근 30분의 1분 단위 상태 흐름](../data/statistics.md) | 원문+설계 제안 | frontend/backend | 4, 6 |
| REQ-012 | [지속 조건·단계·쿨다운·채널별 알림](../measurement/notifications.md) | 원문+설계 제안 | frontend/ai | 7, 9, 10 |
| REQ-013 | [중복에 안전한 세션·결과·이벤트 저장](../api/README.md) | 원문+설계 제안 | backend/frontend | 3, 8 |
| REQ-014 | [핵심 지표와 요일·시간대 집계](../data/statistics.md) | 원문+설계 제안 | backend/frontend | 4, 8 |
| REQ-015 | [세션 목록·상세·기간 필터](../api/README.md) | 원문+설계 제안 | backend/frontend | 8 |
| REQ-016 | [소유자별 접근·삭제·도우미 보안](../security/privacy-and-security.md) | 설계 제안 | 전체 | 4, 9 |
| REQ-017 | [정책·보정 버전과 측정 타당성 추적](../quality/measurement-validation.md) | 원문+설계 제안 | ai/backend | 2, 9, 10 |
| REQ-018 | [센서의 한계와 비의료적 표현](../ui/screens.md) | 원문+설계 제안 | frontend/전체 | 1, 2, 4, 9, 10 |

## 추적 갱신

요구사항을 추가하면 추적표에 명세 경로와 인수 시나리오를 연결합니다. 외부 통신이 있는 요구에는 OpenAPI operationId도 연결합니다. 순수 로컬 화면·계산 요구에 HTTP endpoint를 억지로 추가하지 않습니다.

원문에 없는 예외·보안·재시도 규칙은 설계 제안으로 남깁니다. 결정이 바뀌면 관련 화면, 스키마, 집계, 시나리오를 함께 수정합니다.
