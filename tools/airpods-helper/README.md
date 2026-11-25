# airpods-helper — AirPods 머리 움직임 도우미 (macOS)

AirPods의 머리 움직임은 브라우저가 직접 읽을 수 없어서, Mac에서 이 도우미가 `CMHeadphoneMotionManager`로 읽고
**이 컴퓨터 안(127.0.0.1)에서만** WebSocket으로 웹앱에 보냅니다. 메시지 형식은 [도우미 계약](../../docs/api/airpods-websocket.md)(프로토콜 1.0)을 따릅니다.

> **상태: 미검증.** 이 코드는 Mac 없이 작성해서 아직 한 번도 빌드·실행하지 않았습니다.
> 첫 실행이 첫 확인입니다. 문제가 생기면 아래 "문제 해결"과 오류 메시지를 같이 남겨 주세요.

## 필요한 것

- macOS 14(Sonoma) 이상 Mac, Xcode 또는 Command Line Tools(`xcode-select --install`)
- 머리 추적(공간 음향 머리 추적)을 지원하는 헤드폰: AirPods Pro, AirPods Max, AirPods(3세대) 등
- Windows에서는 AirPods 머리 움직임을 받을 수 없습니다

## 1. 빌드와 실행 (Mac 터미널, 저장소 루트에서)

```bash
cd tools/airpods-helper
swift build -c release
.build/release/airpods-helper
```

성공하면 이렇게 나옵니다.

```
── ecolephant AirPods 도우미 ──
허용 주소: http://127.0.0.1:5173, http://localhost:5173
페어링 코드 (브라우저에 붙여 넣기, 이번 실행에서만 유효):

    3f9c...(48자)

대기 중: ws://127.0.0.1:8765
AirPods를 귀에 끼우면 값이 들어옵니다…
AirPods 상태: connected
```

처음 실행하면 macOS가 **모션 및 피트니스 권한**을 물어봅니다. 허용해 주세요.

옵션: `--help`로 전체 목록을 봅니다. `--port`, `--allow-origin URL`(여러 번), `--rate 20`, `--record FILE.csv`, `--print`, `--no-serve`

## 2. 웹앱과 연결 (같은 Mac)

1. 웹앱을 평소처럼 켭니다: `npm run dev`
2. 브라우저에서 `http://127.0.0.1:5173/calibration?airpods=helper` 를 엽니다 (한 번 열면 그 탭에서 계속 켜져 있음, 끄려면 `?airpods=off`)
3. 보정 화면의 **AirPods 도우미 연결** 버튼 → 터미널의 페어링 코드를 붙여 넣기
4. 상태 줄이 `AirPods(개발용): 머리 움직임 받는 중 · 20Hz · 왕복 ○ms · 축 부호 +1(검증 전)`처럼 바뀌면 연결된 것입니다
5. 카메라를 켜고 **보정 시작**을 누르면 카메라와 AirPods 기준 자세(3초)를 같이 잡습니다. AirPods만 다시 잡으려면 **AirPods 기준만 다시 잡기**
6. 측정 화면의 **측정 방식**에서 `웹캠 + AirPods` 또는 `AirPods`를 고르고 시작합니다 (도우미 플래그가 꺼져 있으면 `웹캠`으로 고정)

페어링 코드는 URL에 넣지 않고 브라우저 메모리에만 둡니다. 도우미를 다시 켜면 코드가 바뀝니다.

## 3. 축 확인 (5분, 처음 한 번 — DEC-003)

`pitch`가 고개를 숙일 때 커지는지 작아지는지는 실제로 재 봐야 압니다. 웹앱은 이 부호를 설정값으로 둡니다.

```bash
.build/release/airpods-helper --no-serve --print
```

1초마다 `pitch +3.2°   roll -1.0°   yaw +12.4°`처럼 나옵니다. AirPods를 끼고 아래 순서대로 하며 **pitch 값**을 적습니다.

| 순서 | 자세 | 적을 값 |
|---|---|---|
| 1 | 바른 자세로 3초 | pitch ____ |
| 2 | 고개만 천천히 숙여 책상 보기 | pitch ____ (커졌나/작아졌나) |
| 3 | 바른 자세로 돌아오기 | pitch ____ (1과 비슷해야 함) |
| 4 | 고개를 위로 들기 | pitch ____ (2와 반대 방향이어야 함) |
| 5 | 고개를 좌우로 기울이기(귀를 어깨 쪽으로) | roll이 변하고 pitch는 거의 그대로인지 |
| 6 | 고개를 좌우로 돌리기 | yaw가 변하고 pitch는 거의 그대로인지 |

판단:
- 2에서 pitch가 **커지면** 부호 `+1` → 웹앱 주소에 `?airpods-sign=1`
- 2에서 pitch가 **작아지면** 부호 `-1` → 웹앱 주소에 `?airpods-sign=-1`
- 5·6에서 pitch가 크게 변하면 축이 섞인 것이니 결과를 그대로 기록하고 알려 주세요

결과는 날짜, AirPods 모델·펌웨어, macOS 버전과 함께 `docs/quality/measurement-validation.md`의 기록 양식으로 남기고, 부호가 확정되면 DEC-003에 적습니다.

## 4. 실험할 때 기록하기

영상 촬영(`tools/pose-compare/evaluate_segments.py`용)과 같이 AirPods 값을 파일로 남길 수 있습니다.

```bash
.build/release/airpods-helper --record ~/airpods-P01.csv
```

- 열: `helper_monotonic_ms, seq, pitch_rad, roll_rad, yaw_rad, rot_x, rot_y, rot_z, status`
- 영상과 시각을 맞추려면 녹화 시작 직후 **고개를 아래로 두 번 빠르게 끄덕이기**를 하면 영상과 pitch 그래프에서 같은 순간을 찾을 수 있습니다
- Ctrl+C로 끝내면 `기록 N줄 저장`이 나옵니다
- 파일은 저장소 밖이나 `.data/`(git 제외)에 두고, 서버·메신저 단체방에 올리지 않습니다

## 보안

- 127.0.0.1(루프백)에서만 열립니다. 같은 와이파이의 다른 기기는 접속할 수 없습니다
- 허용한 웹 주소(Origin)에서 온 연결만 받고, 첫 메시지로 올바른 페어링 코드를 보내야 데이터를 보냅니다
- 페어링 코드를 5번 틀리면 30초 동안 막힙니다
- 카메라는 쓰지 않고, 머리 기울기 값 외에는 아무것도 보내지 않습니다

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| `헤드폰 모션을 쓸 수 없습니다` | macOS 14 이상인지, 머리 추적 지원 모델인지, AirPods가 이 Mac에 연결돼 있는지 |
| `모션 권한이 꺼져 있습니다` | 시스템 설정 → 개인정보 보호 및 보안 → 모션 및 피트니스 |
| 권한 창이 안 뜨고 값도 안 들어옴 | 명령줄 프로그램에 Info.plist가 안 붙었을 수 있음. Xcode에서 새 macOS App 프로젝트를 만들고 `main.swift` 내용을 옮겨 실행해 보기(앱의 Info.plist에 `NSMotionUsageDescription` 추가) |
| 브라우저에 `이 주소는 도우미에서 허용되지 않았어요` | 웹앱 주소가 허용 목록과 다름. `--allow-origin http://127.0.0.1:5173`처럼 실제 주소를 넣어 실행 |
| `페어링 코드가 맞지 않아요` | 도우미를 다시 켜면 코드가 바뀜. 터미널의 최신 코드 사용 |
| `서버를 열 수 없습니다` | 포트가 사용 중. `--port 8766`으로 실행하고 웹앱 주소에 `?airpods-url=ws://127.0.0.1:8766` |
| 상태가 `시계 맞추는 중`에서 멈춤 | 도우미 터미널에 오류가 있는지, 브라우저 개발자 도구 콘솔 확인 |
