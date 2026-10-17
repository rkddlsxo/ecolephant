# 합성 입력 생성기

실제 장치 없이 파생 결과를 만드는 데모 CLI입니다. 실행하지 않으면 데이터를 만들거나 전송하지 않습니다.
원본 카메라·IMU 데이터와 실제 알림 전달 이벤트를 만들어내지 않습니다.

```sh
.venv/Scripts/python.exe tools/simulator/session.py
.venv/Scripts/python.exe tools/simulator/session.py --upload
```

macOS/Linux에서는 `.venv/bin/python`을 사용합니다. 기본 출력은 Git에서 제외된 `.data/simulation.json`입니다.
기본 100초: 기준 범위 15초 → 높은 신호 60초 → 기준 범위 15초 → 신호 누락 10초입니다.
업로드는 실행 중인 로컬 API와 setup이 생성한 로컬 토큰을 사용합니다.
CLI는 실제 시간만큼 기다리지 않으며 대량 합성 기록에 사용합니다.

제품·실측 테스트를 통과했다는 의미는 아닙니다. [구현 상태](../../docs/development/mvp-status.md)를 참고하세요.
