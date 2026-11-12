# 세션과 파생 결과 데이터 모델

저장 구조는 설계 제안입니다. 실제 DB와 마이그레이션 방식은 DEC-008에서 선택합니다. 요청 필드는 [OpenAPI](../api/openapi.json)가 기준입니다.

```mermaid
erDiagram
    OWNER ||--o{ SESSION : owns
    POLICY ||--o{ SESSION : applies
    SESSION ||--o{ SAMPLE_WINDOW : contains
    SESSION ||--o{ SESSION_EVENT : records
```

| 엔터티 | 주요 값 | 제약 |
|---|---|---|
| Owner | 내부 소유자 식별자 | 인증 문맥에서 결정. 발급 방식 DEC-005 |
| Policy | id, 불변 설정 snapshot, mapping 상태, approved 여부 | 변경 시 새 id. 테스트는 미승인 초안 허용, 실측은 승인과 해당 매핑 검증 필요 |
| Session | id, client_session_id, owner, started_at, ended_at, requested_mode, policy_id, status, final_seq, final_event_seq | 소유자+client_session_id 유일. 완료 후 추가 결과 금지 |
| SampleWindow | session_id, seq, elapsed_start_ms, duration_ms, calibration_epoch, active_mode, quality, 각도·level·reason·confidence | session_id+seq 유일. 같은 seq의 내용 변경 거부 |
| SessionEvent | event_id, event_seq, session_id, elapsed_ms, type, 제한된 payload | event_id 전역 유일, session_id+event_seq 유일. 내용 변경 금지 |

## 시간과 연속성

`seq`는 1부터 증가합니다. 각 창은 1~1000ms이며 창을 건너뛰지 않습니다. 창 길이는 일시정지·무효 시간을 포함하고 상태 변경이나 종료 경계에서 짧을 수 있습니다. 같은 세션에서 창은 겹치지 않고 `previous.elapsed_start_ms + previous.duration_ms = next.elapsed_start_ms`를 충족합니다.

일시정지·수집 중단 시간도 각도가 null인 무효 창으로 표현합니다. 저장 지연 때문에 서버 수신 시각을 측정 시각으로 쓰지 않습니다. 벽시계 시각은 `started_at + elapsed_start_ms`로 해석합니다. 클라이언트 날짜를 신체 활동의 증명으로 취급하지 않습니다.

배치는 순서가 바뀌어 도착할 수 있습니다. 서버는 창을 저장하되 가장 긴 연속 seq를 반환합니다. 종료의 final_seq까지 창과 final_event_seq까지 이벤트가 연속 전송되었는지 확인하고, 누락이 있으면 409로 종료를 보류합니다. final_seq=0은 창이 없는 세션에만 허용합니다. 저장된 최대 seq/event_seq보다 작은 final_seq/final_event_seq는 거부합니다. ended_at은 started_at에 최종 창 끝의 상대 시간을 더한 값과 일치해야 합니다.

## 저장 정책

- 서버 허용: 파생 각도·판정·품질·시간, 모드, 정책 ID, 보정 epoch, 알림 실행·교정 이벤트.
- 로컬 전용: 영상·이미지·관절점, 얼굴·어깨 원본 특징, 보정 원본, pitch/roll 원본 스트림, 회전 속도.
- 원시 데이터 삭제는 세션 종료·권한 해제 때 수행합니다. 파생 결과의 보관 기간은 DEC-006에서 확정합니다.
- 세션 삭제는 창·이벤트·캐시·집계의 관련 값을 함께 삭제합니다. 백업 삭제 정책도 공개 전 확정합니다.

조회용 집계 캐시는 재생성 가능해야 합니다. 원본 결과 창과 정책 snapshot 없이 요약 숫자만 덮어쓰지 않습니다.

## 현재 구현

SQLite와 DynamoDB 어댑터는 정책 ID별 원본을 조건부 등록하고 세션에도 당시 설정을 저장합니다.
동일 ID에 다른 내용을 등록하면 409로 거부합니다. 정책 목록에서 제거한 세션도 기존 시작 요청의 재시도와 결과 전송이 가능합니다.
과거 snapshot 없는 `draft-web-v0`만 고정된 최초 초안으로 복원하며, 다른 버전의 snapshot이 없으면 처리를 중단합니다.
기본 정책(`contracts/policy.json`, `draft-web-v0`, 각도 판정)에 더해 `contracts/policies/*.json`의 정책을 함께 제공합니다. 앱은 변화량 판정 정책 `draft-web-v1`을 씁니다(원본: `backend/harness/fixtures/policy/change-v1.json`, `npm run contracts:sync`로 복사).
정책 원본은 개인 결과와 별개로 유지됩니다. 정책 철회 시 진행 중 세션을 어떻게 중단할지는 운영 전 결정이 필요합니다.
DynamoDB의 중단된 삭제는 재시도할 수 있으며, 이벤트 ID가 다른 세션에 재사용된 경우 그 식별자를 보존합니다.
내부 `append_state`에는 연속 순번·끝 시각·보정 epoch·집계 합(각도 합과 각도가 있는 시간)과 마지막 알림 시각을 보관합니다. 결과 창과 같은 트랜잭션에서 갱신하며 원본 영상·관절점·IMU는 포함하지 않습니다.
이전 형식이나 순서가 바뀐 배치는 전체 기록을 검증해 상태를 재구성합니다. 알림이 기존 결과 끝에 걸친 경우도 전체 재계산합니다.
연속 저장 중 완료된 1분 타임라인은 별도 요약 행으로, 진행 중인 분은 세션 내부 상태로 보관합니다. 결과 창과 원자적으로 저장하며 세션 삭제 때 함께 제거합니다.
분 경계에 맞는 조회는 요약을 사용합니다. 이전 기록·순서 누락·요약 누락이나 비정렬 범위는 원본 창으로 계산합니다.
