# 로컬 실행 안내

## 기본 실행

Node 22.12+ · npm · Python 3.12+가 필요합니다. 저장소 루트에서 실행합니다.

```sh
npm ci
npm run setup
npm run dev
```

Python을 못 찾으면 `npm run setup -- --python "Python 실행 파일의 절대 경로"`를 사용합니다.
setup은 `.venv`, `.data`, `backend/.env`, `frontend/.env.local`을 만들고 API 타입을 생성합니다.
기존 환경 파일과 저장 기록을 덮어쓰지 않습니다. 로컬 토큰이 달라졌다면 두 환경 파일을 같은 값으로 맞춘 뒤 재시작합니다.
이 파일과 디렉터리는 Git에서 제외되며 개인 장치에서만 사용합니다.

- 화면: `http://127.0.0.1:5173`
- 백엔드: `http://127.0.0.1:5000`
- Windows 실행: 설치 후 [start-mvp.cmd](../../start-mvp.cmd)를 더블클릭할 수 있습니다.
- 중지: 실행한 터미널의 Ctrl+C.
- SQLite: `.data/ecolephant.sqlite3`, 서버를 재시작해도 승인된 기록은 유지됩니다.
- 새로고침·탭 강제 종료: 아직 전송하지 않은 메모리 큐는 복원되지 않습니다. 먼저 종료·저장하세요.

## 화면에서 확인할 흐름

1. 방식을 선택하고 3초 데모 기준을 설정합니다.
2. 저장 안내를 확인한 뒤 시작합니다.
3. 자동/높은 신호/누락/수동 각도로 상태를 바꾸고 일시정지·재설정을 사용합니다.
4. 20초 후보 뒤 1차, 전달 후 30초 지속 시 2차 화면 알림을 표시합니다. 예시 수치입니다.
5. 종료하고 저장한 뒤 기록·통계·상세·삭제를 이용합니다.

## 선택: DynamoDB Local

기본 SQLite 실행과 동시에 포트 5000을 사용하지 않습니다. Docker가 설치된 경우:

```sh
docker compose -f compose.yml up --build
npm run dev:frontend
```

Compose는 DynamoDB Local 초기화 후 Flask를 시작합니다. 로컬 데이터는 별도 Docker 볼륨에 남습니다.
이 경로와 AWS 어댑터는 아직 실행 검증하지 않았습니다.

## 개발 도구

- `npm run build`: ai 타입 확인과 프론트 배포 빌드.
- `npm run lint`: 프론트·분석 모듈 정적 검사.
- `.venv/Scripts/ruff.exe check backend`: 백엔드 정적 검사.
- `npm run contracts:sync` / `contracts:check`: 정식 명세와 생성 복사본·타입 동기화.
- `npm run format`: 코드 포맷. Vitest/Testing Library는 설정만 준비했습니다.

루트 `package-lock.json`을 기준으로 설치합니다. frontend 폴더에 별도 잠금 파일을 만들지 않습니다.
