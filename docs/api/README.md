# HTTP 결과 저장 API

[OpenAPI 3.1 JSON](openapi.json)이 필드·자료형·상태 코드의 기준입니다. 1차 Flask MVP는 아래 12개 HTTP 동작을 구현했습니다. 실환경 계약·통합 검증은 아직 수행하지 않았습니다. 별도 영상·관절점 업로드 API는 정의하지 않습니다.

## 경로와 책임

| method | path | operationId | 용도 |
|---|---|---|---|
| GET | `/health` | `getHealth` | 기동 상태 확인 |
| GET | `/api/v1/policies` | `listPolicies` | 사용 가능한 불변 정책 목록 |
| POST | `/api/v1/sessions` | `createSession` | 보정 후 세션 생성 |
| GET | `/api/v1/sessions` | `listSessions` | 소유자 세션 목록 |
| GET | `/api/v1/sessions/{session_id}` | `getSession` | 세션 상세와 모드별 요약 |
| DELETE | `/api/v1/sessions/{session_id}` | `deleteSession` | 세션과 관련 결과 삭제 |
| POST | `/api/v1/sessions/{session_id}/samples:batch` | `ingestSampleBatch` | 파생 결과 창 배치 저장 |
| POST | `/api/v1/sessions/{session_id}/events:batch` | `ingestEventBatch` | 허용된 상태·알림 이벤트 저장 |
| GET | `/api/v1/sessions/{session_id}/events` | `listSessionEvents` | 세션 이벤트 목록 |
| POST | `/api/v1/sessions/{session_id}/complete` | `completeSession` | 최종 전송 확인 후 세션 종료 |
| GET | `/api/v1/sessions/{session_id}/timeline` | `getSessionTimeline` | 1분 단위 상태 타임라인 |
| GET | `/api/v1/statistics` | `getStatistics` | 기간·시간대별 모드 분리 통계 |

## 시작과 전송

1. 등록된 정책과 선택 모드를 확인하고 로컬 보정을 완료합니다.
2. client_session_id와 Idempotency-Key를 고정해 세션을 생성합니다. 네트워크 재시도마다 새 ID를 만들지 않습니다.
3. 1초 이하 결과 창을 순서대로 만들고 최대 60개·64KiB 배치로 전송합니다. 초기 전송 주기는 5초 제안입니다.
4. 상태·알림 이벤트는 별도 배치로 보내고 수신 확인 전까지 메모리 큐에 유지합니다. 원시 입력은 큐에 넣지 않습니다.
5. 종료 시 모든 결과·이벤트 배치 승인을 받은 뒤 final_seq·final_event_seq와 ended_at으로 완료합니다. 연속성이 없으면 완료를 보류합니다.

초기 세션 생성이 실패하면 측정 시각을 시작한 것처럼 서버 기록을 만들지 않습니다. 생성 재시도 중 started_at은 고정합니다. 시작 요청부터 승인까지 실제 결과가 없으면 그 구간은 unknown 창으로 표현합니다. 승인 전에는 자세 알림을 실행하지 않습니다. 시작 승인이 오래 지연되면 취소·재시도와 보정 재확인 절차를 제공합니다.

## 재시도와 업무 제약

- 세션 생성은 소유자+client_session_id와 idempotency key로 중복을 억제합니다. key 보관 24시간은 제안이며 client_session_id 유일 제약은 별도로 유지합니다.
- 창은 (session_id, seq), 이벤트는 event_id와 세션 내 event_seq로 중복을 확인합니다. 같은 ID·동일 본문은 성공, 다른 본문은 409입니다.
- 배치 내 하나라도 잘못되면 전체를 거부합니다. 422 issues로 위치를 반환하고 오류 원본·비밀을 그대로 반사하지 않습니다.
- 429·503·전송 실패는 지수 지연과 jitter로 재시도합니다. 4xx 입력·소유권·상태 오류는 수정 없이 반복하지 않습니다.
- active 세션만 새 결과를 받습니다. completed 세션의 이미 승인된 동일 결과 재전송은 duplicate로 답하고 새 데이터는 409입니다.
- 창 겹침·역행·epoch 역행, 종료 시각과 final_seq의 불일치, 교정 이벤트의 선행 알림 부재, 2차 알림의 선행 1차 부재는 업무 검증으로 거부합니다.
- 이벤트 순서가 바뀌어 도착할 수 있으므로 배치 내 참조 또는 이미 저장된 참조를 허용합니다. 종료 전 모든 참조가 해소되어야 합니다.

## 소유권과 삭제

health 외 요청에는 인증된 소유자 문맥이 필요합니다. 현재 로컬 MVP는 setup이 생성한 전용 Bearer 토큰을 쓰며 Cognito 로그인 UI는 미연결입니다. 토큰 발급·브라우저 보관은 DEC-005 결정 대기입니다. 세션 목록의 기간 필터는 started_at에 적용하며, 이벤트는 (elapsed_ms, event_id), 세션은 (started_at, id)의 고정 정렬로 커서를 구성합니다. 본문에 owner_id를 받지 않습니다. 타인 조회는 404, 타인 삭제와 이미 없는 삭제는 204로 정보 노출을 줄이는 설계 제안입니다.

## 시간과 오류

시각은 offset을 포함한 RFC3339이며 서버에서 UTC로 정규화합니다. 상대 시간은 정수 ms, 각도는 degree, 원시 helper 단위는 rad입니다. NaN·Infinity·알 수 없는 필드·범위 밖 값은 거부합니다. `null`과 0은 다릅니다.

오류는 `application/problem+json`의 code, message, request_id, 선택적 issues를 사용합니다. 400은 구문, 401은 인증, 404는 조회 대상 없음, 409는 상태·중복 충돌, 413은 크기, 422는 의미 제약, 429는 빈도, 503은 저장 장애입니다. 요청·정책·로그의 개인정보 조건은 [보안 명세](../security/privacy-and-security.md)를 따릅니다.

## 예시와 검사

실제 shape 예시는 [HTTP 계약 fixture](../../harness/fixtures/http/contract-cases.json)에 있습니다. 각 예시는 유효·무효 기대를 포함합니다. 문서 검사는 표준 OpenAPI·JSON Schema 검증과 추가 시간·통계 불변식 검사를 실행합니다. 인증 발급·DB 트랜잭션·네트워크 동작은 제품 구현 시 인수 검증해야 합니다.

## 1차 구현 추가 사항

SessionCreate와 Session에 선택 필드 `data_source=demo`를 추가했습니다. 누락된 초안 요청도 demo로 기록하며 실제 센서 데이터로 해석하지 않습니다.
완료된 모든 결과를 실제 장치 검증처럼 표시하지 않습니다. 부분 창은 일시정지·재설정 경계에서도 만들어질 수 있으며 최대 1000ms·연속성 규칙을 유지합니다.
[실행](../development/local.md)과 [남은 작업](../development/mvp-status.md)을 참고하세요.
