# ecolephant

자세 습관을 살펴보는 웹 MVP입니다. **1차 버전은 합성 데이터로 동작하는 로컬 데모**입니다.
실제 웹캠 자세 추정과 AirPods 모션 연결, 클라우드 로그인·배포는 후속 작업입니다.

## 시작

Node 22.12+와 Python 3.12+가 필요합니다. 저장소 루트에서 실행합니다.

```sh
npm ci
npm run setup
npm run dev
```

화면: `http://127.0.0.1:5173` · API: `http://127.0.0.1:5000`.
Windows에서 설치를 마쳤다면 [start-mvp.cmd](start-mvp.cmd)를 더블클릭해서 실행할 수 있습니다.
중지는 실행한 창에서 Ctrl+C입니다. 자세한 안내는 [로컬 실행](docs/development/local.md)을 확인하세요.

## 사용할 수 있는 흐름

방식 선택 → 데모 기준 설정 → 실시간 판정·화면 알림 → 일시정지·재설정 → 종료·저장 → 기록·통계·삭제.
카메라 미리보기는 선택 기능이며, 영상 분석과 서버 전송에 사용하지 않습니다.

| 폴더 | 내용 |
|---|---|
| [frontend](frontend/README.md) | React · TypeScript 5.9 · Vite 8, 준비·측정·기록 화면 |
| [backend](backend/README.md) | Flask · Python 3.12, 12개 API 동작, 저장·집계 |
| [ai](ai/README.md) | 브라우저 실행 TypeScript 판정·알림·합성 입력 |
| [infra](infra/README.md) | CDK Python 서버리스 초안, 미배포 |
| [simulator](tools/simulator/README.md) | 합성 창 생성·선택적 업로드 CLI |
| [docs](docs/index.md) | 제품·API·실행·구현 현황 |
| [harness](harness/NAVIGATOR.md) | 작은 주제별 작업 지침·명세·문서 검사 |

## 현재 상태

**[구현된 부분과 남은 부분](docs/development/mvp-status.md)**에서 코드 구현과 검증 상태를 구분합니다.
화면의 예시 각도는 실제 카메라나 이어폰에서 측정한 값이 아닙니다. 의료 진단에 사용하지 않습니다.
