# pose-compare — 자세 모델 비교 도구

같은 영상에 MediaPipe lite, MoveNet Lightning, RTMPose-t, YOLO11n-pose를 돌려
서비스가 쓰는 점 5개(코, 양쪽 귀, 양쪽 어깨)를 CSV로 모으고, 누락률·흔들림·Sapiens와의 일치도를 계산합니다.

- 지표 정의와 선택 규칙: Project 문서 `에코끼리_모델비교기록.md` 2장·4장
- **속도(S1~S4)는 여기서 재지 않습니다.** 서비스는 브라우저에서 돌기 때문에 속도는 브라우저에서 잰 값만 기록합니다.
  `extract.py`가 출력하는 Python 추론 시간은 참고용입니다.
- **영상과 결과는 내 컴퓨터에만 둡니다.** 기본 출력 폴더 `.data/pose-compare/`는 git에 올라가지 않습니다.
  키포인트·프레임을 서버나 로그로 보내지 않습니다 (AGENTS.md).
- Sapiens와 비교한 A1/A2는 **정확도가 아니라 더 큰 모델과의 일치도**입니다. 정확도 판단은 측면 CVA 라벨(J1)로 합니다.

## 1. 설치 (WSL, 저장소 루트에서)

```bash
python3 -m venv .venv-pose
source .venv-pose/bin/activate
pip install -r tools/pose-compare/requirements.txt
python -m pytest tools/pose-compare -q
```

성공하면 `10 passed`가 나옵니다.

## 2. 모델 파일 준비

| 모델 | 준비 |
|---|---|
| MediaPipe lite | `frontend/public/mediapipe/pose_landmarker_lite.task` (프론트에서 쓰는 파일 그대로) |
| MoveNet Lightning | Kaggle Models `google/movenet` → singlepose-lightning TFLite(float16) 내려받기 |
| RTMPose-t | 처음 실행할 때 rtmlib가 자동으로 내려받음 |
| YOLO11n-pose | 처음 실행할 때 ultralytics가 `yolo11n-pose.pt`를 자동으로 내려받음 |

## 3. 키포인트 추출 (모델마다 한 번씩, 같은 CSV에 쌓임)

```bash
python tools/pose-compare/extract.py .data/pose-compare/video.mp4 --model mediapipe --mediapipe-task frontend/public/mediapipe/pose_landmarker_lite.task
python tools/pose-compare/extract.py .data/pose-compare/video.mp4 --model movenet --movenet-tflite .data/pose-compare/movenet_lightning.tflite
python tools/pose-compare/extract.py .data/pose-compare/video.mp4 --model rtmpose
python tools/pose-compare/extract.py .data/pose-compare/video.mp4 --model yolo11n
```

각 줄이 끝나면 `<모델>: N프레임 저장 → .data/pose-compare/points.csv`가 나옵니다.
같은 모델을 다시 돌리면 분석할 때 마지막 결과만 씁니다.
긴 영상은 `--stride 3`처럼 건너뛰어도 되지만, **모든 모델에 같은 값**을 씁니다.

## 4. Sapiens 기준 만들기 (Colab GPU)

```bash
python tools/pose-compare/extract.py .data/pose-compare/video.mp4 --dump-frames 5
```

`.data/pose-compare/frames/`의 JPG를 Colab에 올려 Sapiens pose 데모를 `--save_json`으로 돌리고, JSON 폴더를 다시 내려받습니다.
Colab에 올린 프레임은 끝나면 지웁니다 (본인 영상만, 동의 범위 안에서).

```bash
python tools/pose-compare/import_sapiens.py .data/pose-compare/sapiens_json --fps 30 --width 1280 --height 720 --check .data/pose-compare/frames/frame_000000.jpg
python tools/pose-compare/import_sapiens.py .data/pose-compare/sapiens_json --fps 30 --width 1280 --height 720
```

첫 줄은 점 이름이 맞게 찍혔는지 확인하는 이미지(`check_frame_000000.jpg`)를 만듭니다. 틀리면 `--index`로 인덱스를 고칩니다.
`--fps`, `--width`, `--height`는 원본 영상 값입니다.

## 5. 지표 계산

`segments.example.json`을 `.data/pose-compare/segments.json`으로 복사해 영상의 "가만히 있는 구간"(static) 시간을 적습니다.

```bash
python tools/pose-compare/metrics.py .data/pose-compare/points.csv --segments .data/pose-compare/segments.json --reference sapiens
```

마크다운 표가 출력됩니다. 그대로 `에코끼리_모델비교기록.md` 5장(테스트 기록)에 붙이고, 날짜·기기·영상 조건을 함께 적습니다.

## 6. 점 위치가 맞는지 먼저 확인하기

모델마다 점 번호 체계가 다릅니다 (MediaPipe 33점, 나머지 COCO 17점). 처음 한 번은 결과 CSV의 좌표를 프레임 위에 찍어 보거나,
`--max-frames 30`으로 짧게 돌려 값이 상식적인지(귀가 어깨보다 위, 왼귀 x > 오른귀 x 등) 확인합니다.

## 알려진 차이·제한

- RTMPose는 rtmlib의 YOLOX-tiny 사람 검출기를 씁니다. 브라우저 계획은 RTMDet-nano라서 속도·누락률이 다를 수 있습니다.
- YOLO11은 AGPL-3.0입니다. 내 컴퓨터에서 비교만 하고 서비스에 넣지 않습니다.
- 모델 실행 코드(`extract.py`의 각 runner)는 클라우드에서 모델을 내려받을 수 없어 실제 모델로 검증하지 못했습니다.
  지표 계산(`metrics.py`, `import_sapiens.py`)만 합성 데이터 테스트로 검증했습니다.
