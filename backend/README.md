# Flask 결과 저장 API

Python 3.12 · Flask 3.1 · Waitress 로컬 서버입니다. 저장소 루트에서 `npm run setup`, `npm run dev`로 시작합니다.

## 구조

| 모듈 | 책임 |
|---|---|
| `ecolephant/__init__.py` | 앱 생성·설정·요청 한도·안전한 오류 |
| `auth.py` | 로컬 데모 토큰, 배포용 Cognito JWT 검증 경로 |
| `contracts.py` | OpenAPI 요청 검증·파생 신호 일치 확인 |
| `routes.py` / `service.py` | 12개 HTTP 동작·멱등성·연속성·종료 |
| `storage.py` | 기본 SQLite 트랜잭션 저장 |
| `dynamo.py` | DynamoDB Local/AWS 어댑터, 실환경 미검증 |
| `metrics.py` | 시간 가중·방식별 집계·타임라인·시간대 버킷 |
| `contracts/` | 정식 명세에서 생성한 런타임 복사본 |

## 운영 경계

- 기본 실행은 루프백 전용이며 무작위 로컬 토큰을 사용합니다. 일반 사용자 로그인은 아닙니다.
- health 이외 API는 소유자 인증이 필요합니다. 서버는 본문 owner_id를 받지 않습니다.
- 완성된 동일 배치는 중복 승인하고, 내용이 다른 식별자·종료 누락은 409로 거부합니다.
- 영상·관절점·원시 IMU 필드는 폐쇄된 요청 스키마에서 거부합니다. 요청 원문을 오류·로그에 반사하지 않습니다.
- 삭제는 결과·이벤트를 제거합니다. 지연된 생성 재시도로 복원되지 않도록 불투명 식별자 tombstone만 유지하며 보관 기간은 DEC-006에서 정합니다.
- 배포용 Lambda는 Cognito 설정 없이는 시작하지 않습니다. 로컬 토큰으로 배포되는 것을 차단합니다.

[HTTP 계약](../docs/api/README.md) · [로컬·Docker 실행](../docs/development/local.md) · [클라우드 상태](../infra/README.md).
