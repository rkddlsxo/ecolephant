# 브라우저 분석 모듈

TypeScript 순수 함수 패키지 `@ecolephant/ai`입니다. 별도 AI 서버는 없습니다.

| 파일 | 내용 |
|---|---|
| `src/decision.ts` | 파생 신호의 방식·품질·조합 판정 |
| `src/alerts.ts` | 지속·1/2차·전달 확인·쿨다운·교정 관찰 상태 |
| `src/demo.ts` | 실제 센서와 분리된 합성 관측값 |
| `src/types.ts` | 관측·파생 창·모드 타입 |
| `src/policy.json` | 공통 예시 정책에서 생성한 복사본 |

입력은 이미 단위가 정규화된 관측값입니다. 이 모듈은 DOM·네트워크·저장소에 접근하지 않습니다.
화면 알림이 실제 렌더링된 뒤 frontend가 전달 확인을 돌려줍니다. 후보 생성만으로 전달 성공을 기록하지 않습니다.

**미구현:** 포즈 모델·관절점 추출·검증된 각도 매핑·AirPods 도우미·실제 센서 보정.
합성 입력은 정책 동작을 보여주기 위한 예시이며 모델 성능을 증명하지 않습니다.

`npm run build --workspace ai`는 정적 타입을 확인합니다. [판정 규칙](../docs/measurement/decision-rules.md), [알림 규칙](../docs/measurement/notifications.md)을 함께 읽습니다.
