# record-guide — 검증 영상 로컬 녹화 도구

검증 실험 영상을 **서비스 보정 화면과 같은 조건**으로 찍는 개발용 도구입니다.

- 서비스 화면이 아닙니다. frontend의 페이지·라우트·레이아웃에 들어가지 않고, 배포하지 않습니다.
- 서비스와 같은 코드를 씁니다: MediaPipe 어댑터(`frontend/.../mediapipe-adapter.ts`), 가이드 판정 `guideFit`·`defaultGuide`, 3초 보정 `advanceCalibration`(`ai/`). 가져다 쓰기만 하고 고치지 않습니다.
- 서비스처럼 **가이드 안에서 3초 기준 자세를 통과해야** 녹화를 시작할 수 있습니다.
- 화면에 자세 지시를 시간에 맞춰 띄우고(음성 안내 선택), 구간표를 자동으로 만듭니다. 구간표를 손으로 적지 않습니다.
- 영상과 결과 파일은 이 컴퓨터의 다운로드 폴더에만 저장됩니다. 서버로 보내지 않습니다.

## 1. 켜기 (WSL, 저장소 루트)

```bash
npm run pose:assets          # 처음 한 번 (frontend/public/mediapipe/ 에 모델 파일)
npx vite --config tools/record-guide/vite.config.ts
```

Windows 크롬에서 `http://127.0.0.1:5174` 를 엽니다. 서비스 개발 서버(5173)와 따로 돌아갑니다.

## 2. 촬영 배치

- 노트북: 평소 쓰는 자세, 화면 가이드에 맞춰 앉기 (서비스와 같은 기준)
- 측면 폰: 어깨 높이, 몸과 수직, 1.5~2m, 단순한 배경, **소리도 녹음** (맞춤 신호용)
- 스티커: 귀구슬 초록, C7 파랑 (`tools/cva-label/README.md` 2장)
- 조용한 곳 (삐 소리를 측면 영상에서 찾아야 함)

## 3. 순서

1. 참가자 ID(`P05`), 회차(`1`) 입력 → **카메라 켜기**
2. 가이드(점선)가 초록이 될 때까지 자리 맞추기
3. **기준 자세 잡기** → 바른 자세로 3초 (가이드를 벗어나면 처음부터)
4. 측면 폰 녹화 켜기
5. **녹화 시작** → 3초 카운트다운 → 녹화 시작 2초 뒤 **큰 삐 소리 + 화면 깜빡임** (두 영상을 맞추는 신호)
6. 화면·음성 지시대로 자세 바꾸기 (약 4분 50초). 각 단계는 준비 3초(구간에서 제외) + 유지 10초, 마지막은 지시 없이 2분
7. 끝나면 파일 6개가 자동으로 받아짐 → 측면 폰 녹화 멈추기

크롬이 "여러 파일 다운로드"를 물으면 허용합니다. 놓쳤으면 **파일 다시 받기**.
중간에 **멈추기**를 누르면 파일 이름 뒤에 `_partial`이 붙습니다 (평가에 쓰지 않기).

### 대본 (`src/script.ts`의 `defaultScript`)

| #   | label        | 유지  | note                          |
| --- | ------------ | ----- | ----------------------------- |
| 1   | upright      | 10초  | 기준                          |
| 2   | chin_forward | 10초  | 살짝                          |
| 3   | upright      | 10초  |                               |
| 4   | chin_forward | 10초  | 확실히                        |
| 5   | upright      | 10초  |                               |
| 6   | head_down    | 10초  | 살짝                          |
| 7   | upright      | 10초  |                               |
| 8   | head_down    | 10초  | 크게                          |
| 9   | upright      | 10초  |                               |
| 10  | combined     | 10초  | 복합                          |
| 11  | upright      | 10초  |                               |
| 12  | turn         | 10초  | 돌리기·말하기                 |
| 13  | free         | 120초 | 지시 없음 (측면 CVA로만 평가) |

## 4. 받는 파일 (`P05_s1` 예)

| 파일                                          | 내용                                                                            | 옮길 곳               |
| --------------------------------------------- | ------------------------------------------------------------------------------- | --------------------- |
| `P05_s1.mp4` (크롬이 mp4를 못 만들면 `.webm`) | 노트북 영상                                                                     | `.data/test-c/`       |
| `P05_s1.csv`                                  | 평가 도구 구간표 (`label,start,end,note`, 노트북 영상 기준 초). `free`는 제외   | `.data/test-c/`       |
| `P05_s1.landmarks.csv`                        | 브라우저가 실제로 본 관절점 (평가 도구 캐시와 같은 형식)                        | `.data/test-c/cache/` |
| `P05_s1.guide.csv`                            | 프레임별 품질·가이드 판정·대본 단계                                             | `.data/test-c/`       |
| `P05_s1.segments.json`                        | cva-label용 구간 (**삐 소리 = 0** 기준)                                         | `.data/cva/`          |
| `P05_s1.meta.json`                            | 해상도, 분석 fps, 모델, 정책 ID, 가이드, 서비스식 기준값, 구간별 가이드 안 비율 | `.data/test-c/`       |

받은 직후 화면 아래에 "가이드 밖이 20% 넘은 구간"이 나오면 그 구간은 분석 때 따로 봅니다.

```bash
# Windows 다운로드 폴더 → 저장소 (WSL)
mkdir -p .data/test-c/cache .data/cva
mv /mnt/d/Users/sooye/Downloads/P05_s1.landmarks.csv .data/test-c/cache/
mv /mnt/d/Users/sooye/Downloads/P05_s1.segments.json .data/cva/
mv /mnt/d/Users/sooye/Downloads/P05_s1.{mp4,csv,guide.csv,meta.json} .data/test-c/
```

## 5. 평가

```bash
source .venv-pose/bin/activate
python tools/pose-compare/evaluate_segments.py --data-dir .data/test-c
```

캐시(`cache/P05_s1.landmarks.csv`)가 있으면 Python에서 MediaPipe를 다시 돌리지 않고 **브라우저 관절점**을 그대로 씁니다 (서비스와 같은 모델 빌드·타이밍). Python으로 다시 뽑아 비교하려면 `--refresh` (캐시를 덮어쓰므로 먼저 복사해 두기).

측면 CVA (삐 소리가 측면 영상의 몇 ms에 났는지 찾아서 `--sync-ms`로):

```bash
python tools/cva-label/label_video.py .data/cva/P05_s1_side.mp4 --segments .data/cva/P05_s1.segments.json --sync-ms 4120
```

삐 소리 시각은 영상 플레이어에서 소리 파형이나 프레임 단위로 찾습니다. 노트북 영상에서는 녹화 시작 2000ms 지점입니다 (`meta.json`의 `sync_ms`).

## 6. 테스트

```bash
npx vitest run --config tools/record-guide/vite.config.ts   # 대본·파일 형식 10개
npx tsc -p tools/record-guide                               # 타입 검사
```

## 주의

- 카메라 권한은 `127.0.0.1`(localhost)에서만 동작합니다.
- 녹화 중에도 가이드를 벗어나면 화면에 안내만 하고 녹화는 계속합니다 (`guide.csv`에 기록).
- 대본 시간을 바꾸면 `src/script.ts`만 고치면 구간표가 자동으로 맞춰집니다.
- 실험 영상은 동의서 범위 안에서만 촬영·보관합니다.
