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
기존 환경 파일과 저장 기록을 덮어쓰지 않습니다. 로컬 인증 설정이 충돌하면 설치를 중단하고 확인할 위치를 안내합니다.
오류가 나면 실행 환경 변수와 두 환경 파일의 로컬 토큰을 확인해 같은 값으로 맞춘 뒤 `npm run setup`을 다시 실행합니다.
기존 백엔드 로컬 토큰을 교체하면 기록의 소유자가 달라져 기존 기록을 볼 수 없으므로 먼저 기록 유지 방법을 확인하세요.
특수 문자가 들어간 사용자 지정 토큰은 프론트 환경 파일에도 직접 설정해야 합니다. 토큰을 채팅이나 저장소에 공유하지 마세요.
이 파일과 디렉터리는 Git에서 제외되며 개인 장치에서만 사용합니다.

- 화면: `http://127.0.0.1:5173`
- 백엔드: `http://127.0.0.1:5000`
- 기존 `backend/.env`에서 `ECOLEPHANT_ALLOWED_ORIGIN`을 `http://localhost:5173`으로 설정했다면, 프록시를 거치지 않고 API에 직접 연결할 때만 화면 주소와 맞게 수정합니다.
- Windows 실행: 설치 후 [start-mvp.cmd](../../start-mvp.cmd)를 더블클릭할 수 있습니다.
- 중지: 실행한 터미널의 Ctrl+C.
- SQLite: `.data/ecolephant.sqlite3`, 서버를 재시작해도 승인된 기록은 유지됩니다.
- 새로고침·탭 강제 종료: 미전송 큐는 복원되지 않으므로 먼저 종료·저장하세요. 세션 없음 안내 시 정리 전 대기 데이터 폐기 여부를 확인하세요.

## 카메라와 테스트 측정

프론트만 사용할 때는 `npm ci`, `npm run dev:frontend`로 실행합니다. Python·백엔드 연결은 필요하지 않습니다.
백엔드 설정이 없다면 카메라 미리보기만 사용할 수 있고 테스트 기록 저장은 사용할 수 없습니다.
준비 화면에서 카메라를 켜고 브라우저 권한을 허용합니다. 끄기·좌우 반전을 사용할 수 있습니다.
`테스트 측정`은 별도의 합성 입력으로 시작·일시정지·기준 재설정·종료와 저장을 확인합니다.
Flask가 실행되어야 하며 실제 웹캠 또는 AirPods 추정값을 생성하지 않습니다.
자세한 [카메라 안내](camera-preview.md)와 [ML 인계](../measurement/ml-handoff.md)를 확인하세요.

## 선택: DynamoDB Local

기본 SQLite 실행과 동시에 포트 5000을 사용하지 않습니다. Docker가 설치된 경우:

```sh
docker compose -f compose.yml up --build
npm run dev:frontend
```

Compose는 DynamoDB Local 초기화 후 Flask를 시작합니다. 로컬 데이터는 별도 Docker 볼륨에 남습니다.
Docker Compose 경로와 실제 AWS는 아직 실행 검증하지 않았습니다. 동일 어댑터는 DynamoDB Local 3.3.2 단독 실행으로 검사했습니다.

실행 중인 테스트 전용 DynamoDB Local이 있다면 PowerShell에서 API 테스트를 추가로 실행할 수 있습니다.
테스트는 지정된 루프백 서버에 임의의 테스트 테이블을 만들고 삭제합니다. 실제 AWS 주소는 거부합니다.

```powershell
$env:ECOLEPHANT_TEST_DYNAMO_ENDPOINT = 'http://127.0.0.1:8000'
.venv/Scripts/python.exe -m unittest discover -s backend/tests -p 'test_*.py'
Remove-Item Env:ECOLEPHANT_TEST_DYNAMO_ENDPOINT
```

## 개발 도구

- `npm run build`: ai 타입 확인과 프론트 배포 빌드.
- `npm run lint`: 프론트·분석 모듈 정적 검사.
- `.venv/Scripts/ruff.exe check backend`: 백엔드 정적 검사.
- `npm run contracts:sync` / `contracts:check`: 정식 명세와 생성 복사본·타입 동기화.
- `npm run test:run --workspace frontend`: 프론트 합성 세션·모델 경계 검사.
- `node --test scripts/setup-env.test.mjs`: 환경 파일 보존과 설정 충돌 검사. 먼저 `npm run setup`이 필요합니다.
- `node scripts/check-build-secrets.mjs`: 배포 빌드의 로컬 토큰 포함 여부 검사.
- `.venv/Scripts/python.exe -m unittest discover -s backend/tests -p 'test_*.py'`: API·SQLite 통합 검사.
- `npm run format`: 코드 포맷.

8시간 합성 저장·재시도·알림을 별도로 검사하려면 PowerShell에서 실행합니다. 실제 장치나 AWS는 사용하지 않으며 시간이 걸립니다.

```powershell
$env:ECOLEPHANT_LONG_SESSION_STRESS = '1'
.venv/Scripts/python.exe -m unittest discover -s backend/tests -p 'test_long_session_stress.py'
Remove-Item Env:ECOLEPHANT_LONG_SESSION_STRESS
```

루트 `package-lock.json`을 기준으로 설치합니다. frontend 폴더에 별도 잠금 파일을 만들지 않습니다.
[Cognito 연결 설정](authentication.md)은 별도이며 실제 계정 검증 전까지 로컬 실행을 유지합니다.
