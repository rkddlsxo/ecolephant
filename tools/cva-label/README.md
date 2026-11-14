# cva-label — 검증 실험용 측면 CVA 라벨

검증 실험의 **정답 라벨**(머리척추각, CVA)을 측면 영상에서 만듭니다.
귀구슬(이주)과 목 뒤 C7에 붙인 색 스티커를 찾아, C7을 지나는 수평선과 C7→귀구슬 선의 각도를 프레임마다 계산합니다.

- 서비스는 측면 입력을 쓰지 않습니다 (2026-11-11). 측면 영상은 **실험 정답용**입니다.
- `--mediapipe-task`를 주면 MediaPipe 귀–어깨 선으로 만든 **근사 CVA**도 함께 적고, 스티커 값과의 차이를 구간별로 요약합니다. MediaPipe에는 C7 점이 없어서 근사값입니다.
- 영상과 결과는 내 컴퓨터의 `.data/cva/`에만 둡니다 (git 제외). 서버나 로그로 보내지 않습니다.
- 50° 기준(`--threshold`)은 연구에서 쓰는 참고 기준입니다. 진단이 아닙니다.

## 1. 설치

`tools/pose-compare`의 가상환경을 그대로 씁니다.

```bash
source .venv-pose/bin/activate
python -m pytest tools/cva-label -q
```

성공하면 `7 passed`가 나옵니다.

## 2. 촬영 준비

- 스티커: 귀구슬 **초록**, C7 **파랑** (빨강은 피하기). 지름 1cm 이상, 무광
- 측면 폰은 어깨 높이, 몸과 수직 방향, 1.5~2m 거리, 단순한 배경
- 머리카락이 귀구슬 스티커를 가리지 않게
- 색이 다르면 `--tragus-hsv`, `--c7-hsv`로 범위를 바꿉니다 (`h1,s1,v1,h2,s2,v2`, OpenCV HSV)

## 3. 먼저 한 프레임 확인

```bash
python tools/cva-label/label_video.py .data/cva/p01_side.mp4 --check 0
```

`.data/cva/p01_side_check_000000.jpg`에 찾은 스티커(동그라미)와 선이 그려집니다. 스티커가 안 잡히면 HSV 범위나 `--min-area`를 조정합니다.

## 4. 전체 라벨 + 구간 요약

```bash
python tools/cva-label/label_video.py .data/cva/p01_side.mp4 --segments .data/cva/p01_segments.json --mediapipe-task frontend/public/mediapipe/pose_landmarker_lite.task
```

- `p01_side_cva.csv`: 프레임별 `sticker_cva`, 스티커 좌표, `approx_cva`, 사용한 쪽
- `p01_side_cva_segments.csv`: 자세 구간별 스티커 CVA 중앙값·IQR·인식 프레임 수, 근사 CVA 중앙값, (근사 − 스티커) 중앙값, 기준 미만 여부
- 구간 JSON은 `tools/pose-compare/segments.example.json`과 같은 형식입니다 (`start_ms`, `end_ms`, `label`). 동기화(박수·비프음) 시점을 0으로 맞춰 적습니다.
- 스티커가 안 보인 프레임은 빈칸으로 남고 채우지 않습니다.
