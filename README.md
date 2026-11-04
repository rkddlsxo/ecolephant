# ecolephant

현재 단계는 **실제 웹캠 미리보기와 합성 입력 테스트 측정**입니다.
자세 측정 AI 모델은 연결하지 않았고, 테스트 측정은 가상 결과로 API·기록 흐름을 확인합니다.

## 실행

Node 22.12+ · npm이 필요합니다. 저장소 루트에서 프론트만 실행할 수 있습니다.

```sh
npm ci
npm run dev:frontend
```

화면: `http://127.0.0.1:5173` → **카메라 켜기** → 브라우저 권한 허용.
Flask도 함께 실행하려면 Python 3.12+ 환경에서 `npm run setup`, `npm run dev`를 사용합니다.
기존 로컬 설정은 유지하며 설정이 충돌하면 설치 단계에서 안내합니다. 자세한 내용은 [실행 안내](docs/development/local.md)를 확인하세요.
설치된 Windows 환경은 [start-mvp.cmd](start-mvp.cmd)를 더블클릭해 실행할 수 있습니다.

## 현재 사용할 수 있는 기능

- 카메라 권한 요청, 실제 영상 표시, 켜기·끄기, 표시 좌우 반전.
- 권한 거부·장치 없음·사용 중 오류 안내와 재시도.
- 페이지 이동·탭 비활성화·장치 연결 종료 때 카메라 해제.
- 합성 입력으로 시작·일시정지·종료·저장·기록 조회. 실제 측정 결과는 아닙니다.
- 선택형 Cognito 로그인·비밀번호 복구 경로. 실제 계정 연결은 아직 검증하지 않았습니다.

영상·사진·음성을 저장하거나 서버에 전송하지 않습니다. 마이크 권한은 요청하지 않습니다.
카메라 미리보기와 합성 테스트는 별도 경로입니다. 실제 모델은 [ML 인계](docs/measurement/ml-handoff.md)를 따릅니다.

## 안내

- [카메라 사용 안내](docs/development/camera-preview.md)
- [완료·미완료 현황](docs/development/mvp-status.md)
- [실행 안내](docs/development/local.md)
- [로그인 연결](docs/development/authentication.md)
- [작업 하네스](backend/harness/NAVIGATOR.md)
- [제품 요구](PRD.md) · [아키텍처](ARCHITECTURE.md)
