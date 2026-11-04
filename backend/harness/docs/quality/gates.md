# 백엔드 품질 게이트

저장소 루트에서 다음 검사를 실행합니다.

```powershell
.\backend\harness\scripts\check.ps1 -PythonPath .\.venv\Scripts\python.exe
.\.venv\Scripts\python.exe -m unittest discover -s backend/tests -p 'test_*.py'
```

하네스는 OpenAPI와 HTTP 합성 예시, 정책 초안, 문서 링크, 강한 비밀정보 패턴과 검사기 회귀 사례를 확인합니다.
백엔드 테스트는 임시 SQLite를 사용합니다. DynamoDB Local과 장시간 검사는 환경을 준비하거나 별도 설정해야 합니다.
카메라·실측 모델·AirPods·실제 Cognito 계정과 AWS 배포는 별도의 검증 범위입니다.
