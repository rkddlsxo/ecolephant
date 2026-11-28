# ADR-0004 · 웹캠 관절점 모델 후보: MediaPipe Pose Landmarker

- 날짜: 2026-11-05
- 상태: 제안 (ML 담당 진수연 작성, 팀 승인 전)
- 관련: DEC-002, DEC-007, DEC-008, ADR-0001, ADR-0003, [ML 인계](../measurement/ml-handoff.md)

## 배경

ADR-0003에서 `model-adapter`는 모델 선택 전까지 비워 두었습니다. 1차 MVP는 관절점 + 규칙 기반 판정이며
브라우저에서만 분석해야 하므로(ADR-0001), 웹에서 실행되고 코·귀·어깨를 주는 모델이 필요합니다.

## 후보와 근거

- `@mediapipe/tasks-vision` `PoseLandmarker` (Apache-2.0). 33개 점에 코 0, 귀 7·8, 어깨 11·12가 있어
  계약 점을 그대로 제공합니다. VIDEO 모드, GPU/CPU 위임을 지원합니다.
- 버전은 1.1.1로 고정했습니다. 1.2.2는 2026-11-03 배포라 2주 이상 지난 버전을 택했습니다.
- 모델은 `pose_landmarker_lite.task`(float16, 버전 1)입니다. full/heavy와의 눈 비교 결과는 아래
  로컬 확인 결과에 있고, 정량 비교는 검증 실험에서 합니다.
- 다른 후보(MoveNet, BlazePose TF.js 등)의 성능·속도 비교는 아직 하지 않았습니다.

## 구현 선택

- `frontend/src/features/measurement/pose/`에 변환 순수 함수(`pose-result.ts`)와 어댑터(`mediapipe-adapter.ts`)를 둡니다.
- 신뢰도는 `min(visibility, presence)`이며, 영상 밖(0~1 바깥) 점은 잘라내지 않고 `null`로 둡니다.
- 품질: 사람 없음 → `no_pose`, 필수 점(양 어깨 + 코/한쪽 귀)이 없거나 신뢰도 0.7 미만 → `low_confidence`,
  250ms 이상 지난 기준 프레임 대비 머리·어깨 중심 또는 어깨 폭이 어깨 폭의 0.15배 넘게 변하면 `motion`.
  움직임 수치는 픽셀 기준으로 계산하며 **초기 설계값(DEC-007)** 입니다.
- 모델·wasm은 `npm run pose:assets`로 `frontend/public/mediapipe/`에 받아 같은 출처에서 제공합니다(git 제외).
  외부 CDN에서 불러오지 않습니다. wasm은 SIMD/비SIMD 두 종류만 복사합니다(약 26MB).
- `postureModelAdapter`는 아직 `null`입니다. 측정 흐름 연결은 프론트 담당과 합의 후 진행합니다.
- 개발 서버에서 `?pose-debug`를 붙이면 카메라 화면에 점·품질·fps·추론 시간을 표시합니다(로컬 표시만).

## 로컬 확인 결과 (2026-11-05, 진수연 노트북 1대)

- Windows + WSL 우분투, `?pose-debug` 화면, 브라우저 GPU 위임
- 약 14fps (화면 분석 상한 15fps), 프레임당 추론 18~22ms, 브라우저 CPU 약 6%
- 바른 자세 valid, 빠른 움직임 motion, 어깨가 화면 밖 low_confidence, 화면 이탈 no_pose(점 없음) 확인
- 다른 팀원 노트북·CPU 위임 환경은 아직 측정하지 않았습니다.
- 관찰된 한계(lite): 어깨를 일부러 올리거나 내리면 어깨 점이 잘 따라가지 않고,
  정면에서 귀 점이 귀보다 광대뼈 쪽에 찍힙니다. 귀–어깨 높이 차 `h`와 얼굴 폭 `face_width`에 영향을 줄 수 있어
  lite/full/heavy 비교가 필요합니다.
- 비교 방법: `npm run pose:assets -- --model all` 후 `?pose-debug&model=full&all`
  (`model`은 lite·full·heavy, `all`은 33개 점 전체 표시).
- 모델 비교 (같은 노트북, GPU, 화면 분석 상한 15fps):

  | 모델 | fps | 프레임당 추론 | 브라우저 CPU | 점 위치 (눈으로 비교) |
  |---|---|---|---|---|
  | lite | 약 14 | 18~22ms | 약 6% | 기준 |
  | full | 약 14 | 약 23ms | 약 6% | 눈에 띄는 차이 없음 |
  | heavy | 약 14 | 약 40ms | 약 7% | 눈에 띄는 차이 없음 |

  어깨·귀 위치 한계는 세 모델 공통이었습니다. 정확도 이득이 보이지 않아 기본값은 lite로 제안합니다.
  정량 비교(측면 CVA 대비 오차·누락률)는 검증 실험에서 합니다.

## 추가 비교 (2026-11-14, 2026-11-28)

- 2026-11-14: 같은 정면 녹화(1280×720, 1601프레임, 1인)에 MediaPipe lite·MoveNet Lightning·RTMPose-t·YOLO11n-pose를
  Python으로 실행(`tools/pose-compare`). 필수 점 누락률은 모두 10% 이하(0.6% / 2.4% / 0.2% / 8.2%).
  판정에 쓰는 앞쏠림 값 `r`의 정지 구간 흔들림은 MediaPipe 0.0097로 가장 낮았고(RTMPose·YOLO 약 0.019),
  숙임 값 `h`는 RTMPose 0.0353이 가장 낮았습니다(MediaPipe 0.0462). Sapiens 0.3B 대비 일치율(PCK@0.1)은
  YOLO 99.8%·RTMPose 99.4%·MediaPipe 96.2%·MoveNet 94.1%였지만, COCO 계열끼리 점 정의가 같아 생긴 차이일 수 있어
  정확도로 보지 않았습니다.
- 2026-11-28: 측면 CVA를 함께 찍은 검증 영상 4명 5세션에서 MediaPipe lite + `draft-web-v3`로 지시 자세 재현율 18/24,
  바른 자세 구간 오탐 0/25. 고개를 크게 숙이면 어깨 점 신뢰도가 0.7 아래로 떨어져 판단 불가가 되는 경우가 1세션 있었습니다.
- RTMPose와의 판정 정확도 비교는 하지 않았습니다(선택 과제). 위 결과로 lite를 유지합니다.

## 결정과 영향

승인 전 제안입니다. 승인되면 DEC-008의 ai/frontend 분석 스택 항목에 이 기록을 연결합니다.
반환값은 기존 `cameraModelResultSchema`를 그대로 따르며 계약 변경은 없습니다.

## 재검토 조건

- 팀원 노트북에서 처리 속도(fps·CPU)가 부족하거나 GPU 위임이 실패하는 경우
- 검증 실험에서 lite 모델의 귀·어깨 누락률이 높은 경우
- 배포 호스팅에서 26MB 정적 파일 제공이 어렵거나, 모델 다운로드 경로를 빌드에 넣기로 정하는 경우
