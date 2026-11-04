# 프론트엔드

React 19 · TypeScript 5.9 · Vite 8 · npm workspace, Node 22 기준입니다.

## 현재 화면

카메라 미리보기, 합성 입력 테스트 측정, 저장된 기록을 제공합니다.
테스트 측정은 Flask와 연결되며 실제 카메라·AirPods 측정이 아닙니다.
페이지 이동·탭 숨김·장치 종료 때 카메라 스트림을 정리합니다.
연결이 종료된 카메라는 오류를 표시하고 다시 켤 수 있습니다.
AI 모델 어댑터는 null이며 모델·WASM·가중치를 추가하지 않았습니다.
선택형 Cognito 로그인은 계정 발급과 실서비스 검증을 기다립니다.
배포용 인증 API는 HTTPS이며 원격 화면의 명시적 루프백 API 설정은 거부합니다.
기록 내보내기는 타임라인과 이벤트 전체 페이지를 불러오며 실패하거나 화면을 벗어나면 부분 파일을 만들지 않습니다.
진행 중인 측정은 내보내는 동안 내용이 바뀔 수 있으므로 하나의 원자적 시점으로 보장하지 않습니다.
기록은 최신순으로 표시하며 다음 페이지 조회가 실패해도 기존 항목을 유지합니다.
통계는 서울 기준 오늘·7일·30일을 선택하고 일별·시간별 결과를 볼 수 있습니다.
방식·출처·정책별로 구분하며 유효 시간이 없으면 비율을 계산하지 않습니다.
현재 탭의 측정·저장 중 세션은 삭제를 막습니다. 다른 탭·기기의 미완료 기록은 삭제 전 측정 중일 수 있다고 안내합니다.
서버에서 세션을 찾지 못하면 수집·자동 전송을 멈추고 사용자가 확인하기 전까지 미승인 데이터를 메모리에 둡니다.
그 밖의 저장 실패는 같은 데이터로 재시도합니다. 다른 탭·기기에서의 삭제 자체는 막지 못합니다.
진행 중 탭 이탈 시 경고하지만, 브라우저 강제 종료 뒤에는 메모리에만 있던 기록을 복구하지 못합니다.

## 실행

루트 `npm ci`, `npm run dev:frontend`로 카메라 화면을 열 수 있습니다.
Flask와 함께 실행할 때는 `npm run setup`, `npm run dev`를 사용합니다.
주소는 `http://127.0.0.1:5173`입니다.

## 주요 위치

- `src/features/camera/useWebcam.ts`: 실제 MediaStream 수명주기.
- `src/components/CameraPreview.tsx`: 영상 표시·사용자 조작.
- `src/features/measurement/model-adapter.ts`: 후속 모델 연결 자리.
- `src/features/measurement/controller.ts`: 합성 세션의 전송·재시도·종료.
- `src/features/auth/`: 로컬 실행과 Cognito 인증 경계.
- `src/pages/PreparePage.tsx`: 현재 기본 화면.
- `src/pages/HistoryPage.tsx`: 기록·통계 조회.

TanStack Router/Query, Zustand, RHF/Zod, Tailwind 4, Radix, CVA, dnd kit, Motion, Axios, API 생성 타입,
Vitest/Testing Library, ESLint/Prettier/Husky/lint-staged 설정은 기존 구성에 있습니다.
개인 디자인 시스템 패키지는 이름·버전·권한이 전달되지 않아 미연결입니다.

[카메라 안내](../docs/development/camera-preview.md) · [인증 연결](../docs/development/authentication.md) · [현재 상태](../docs/development/mvp-status.md) · [ML 인계](../docs/measurement/ml-handoff.md).
