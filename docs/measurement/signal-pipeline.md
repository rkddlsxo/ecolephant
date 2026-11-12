# 센서 신호와 기준 자세 처리

원문은 랜드마크·얼굴 크기와 머리 자세를 입력으로 제시합니다. 아래 정규화·품질 규칙은 구현 제안이며, 도 단위 웹캠 출력은 검증된 매핑이 있을 때만 생성합니다.

## 로컬 입력 계약

| 관측 | 필드와 단위 | 수명 |
|---|---|---|
| CameraObservation | browser_monotonic_ms, 이미지 크기 px, 코·양쪽 귀·양쪽 어깨의 좌표와 confidence | 로컬 단기 버퍼 |
| HeadMotionObservation | 정렬된 browser_monotonic_ms, pitch/roll rad, rotationRate rad/s, stream_id | 로컬 단기 버퍼 |
| Calibration | 센서별 기준 특징·pitch, 품질, epoch, 생성 시각, 장치 배치 확인 | 현재 세션 로컬 |
| MeasurementWindow | 1초 이하 창의 파생 각도·판정·품질 | 서버 허용 결과 |

좌표는 MediaPipe 입력 영상 기준입니다. 미러링은 표시 단계에서 적용하고 분석 좌표를 중복 반전하지 않습니다. 정규화 좌표로 거리를 계산할 때 영상 가로·세로 크기를 적용해 픽셀 거리로 바꿉니다. 필수 점 누락·신뢰도 부족·0에 가까운 분모는 무효로 처리합니다.

## 웹캠 특징 제안

`face_width = distance(left_ear, right_ear)`, `shoulder_width = distance(left_shoulder, right_shoulder)`로 두고 다음을 로컬 특징으로 사용합니다.

- 얼굴 대 어깨 비율 `r = face_width / shoulder_width`
- 귀·어깨 높이 차이 `h = (mid_shoulder_y - mid_ear_y) / shoulder_width`
- 개인 기준 대비 `r/r0 - 1`, `h-h0`

- (선택) 코 높이 `n = (mid_ear_y - nose_y) / shoulder_width`, 기준 대비 `n-n0`. 코가 없거나 신뢰도가 낮으면 `null`이고 프레임은 `r`·`h`로 계속 사용합니다.

이 값은 무차원 특징이며 도 단위 CVA나 실제 목 각도가 아닙니다. `camera_estimate_deg = f(features, calibration, profile)`의 함수와 계수는 DEC-002에서 기준 측정으로 검증해야 합니다. 검증 전에는 `camera_estimate_deg=null`로 두고 웹캠 각도 기반 정상·주의·높음을 산출하지 않습니다. 합성 각도는 개발 fixture에서만 사용합니다.

### 기준 대비 변화량 판정 (DEC-002, 팀 동의 2026-11-10)

검증 전 MVP의 웹캠 판정은 각도가 아니라 기준 대비 변화량으로 합니다. 구현은 `ai/src/camera-window.ts`입니다.

1. 1초 창 안에서 분석한 프레임의 특징 결과를 모읍니다. 분석 프레임이 3개 미만이면 `no_sensor`, 사용 가능한 프레임 비율이 0.8(`quality.min_valid_coverage`) 미만이면 `motion` 또는 `low_confidence`로 판정하지 않습니다. 부족한 구간을 정상으로 채우지 않습니다.
2. 사용 가능한 프레임의 `rChange`·`hChange`·`nChange` 중앙값을 창 대표값으로 씁니다. 코 신호는 기준과 창 모두에서 절반 이상 있을 때만 씁니다.
3. 단계와 자세 유형을 정합니다. 초기 제안값(DEC-007, 실험 후 조정):

| 신호 | 주의 | 높음 | 의미 |
|---|---|---|---|
| `rChange` | ≥ +0.10 | ≥ +0.20 | 머리가 화면 쪽으로 나옴 |
| `hChange` | ≤ −0.10 | ≤ −0.20 | 귀가 어깨 쪽으로 내려옴 |
| `nChange` | ≤ −0.10 | ≤ −0.20 | 코가 귀 대비 내려옴 |

단계는 앞쏠림(`rChange`)과 숙임(`hChange`, `nChange` 중 더 나쁜 쪽) 중 더 나쁜 쪽입니다. 자세 유형은 앞쏠림만 있으면 `chin_forward`, 숙임만 있으면 `head_down`, 둘 다면 `combined`입니다. 라운드 숄더와 일자목은 범위 밖입니다.

이 판정은 `camera_estimate_deg`를 만들지 않습니다. 각도 환산은 측면 기준 실험에서 평균 비율과 사용자별 오차를 확인한 뒤에만 엽니다.

#### 측정 흐름과 저장 (정책 `draft-web-v1`)

- 판정 방식은 정책의 `camera_judgement`로 고릅니다. `draft-web-v1`은 `change`(변화량), 이전 세션의 `draft-web-v0`은 `angle`(없으면 angle)입니다. 서버는 두 정책을 모두 제공하고 세션마다 당시 정책으로 다시 검사합니다.
- 변화량 기준값은 정책의 `camera_change_thresholds`(`forward`, `drop`, `nose_drop`)에 있습니다. 위 표의 초기 제안값과 같습니다.
- `deriveWindow`는 `Observation.cameraChange`(`camera-window.ts`의 `cameraObservation`으로 만듦)를 받습니다. 결과 창에는 `camera_forward_change`·`camera_drop_change`·`camera_nose_drop_change`(파생 숫자, 관절점 아님)와 `posture_type`이 함께 저장됩니다. 나중에 실험으로 비율을 정하면 이전 기록도 각도로 다시 계산할 수 있습니다.
- 결합 모드는 장치별 역할을 나눕니다(DEC-004 확정 전 임시 규칙): 앞쏠림은 웹캠 변화량, 숙임은 AirPods 각도(15°/30°)로 판정하고 단계는 둘 중 더 나쁜 쪽입니다. 웹캠의 숙임 변화량은 저장만 하고 AirPods가 없을 때만 판정에 씁니다.
- `display_angle_deg`에는 실제로 잰 각도(AirPods)만 넣습니다. 웹캠만 쓰면 `null`이고, 통계의 평균 각도는 각도가 있는 창만으로 계산합니다(없으면 `null`, 화면은 "—").
- `reason_code`는 기존 단계-이유 조합을 유지합니다: 주의는 숙임이면 `head_flexion`, 그 외 `mixed_caution` / 높음은 `forward_shift`·`head_flexion`·`combined_high`. 자세 유형의 세부는 `posture_type`에 있습니다.
- 서버(`backend/ecolephant/contracts.py`의 `change_semantics`)는 같은 규칙으로 단계·이유·자세 유형을 다시 계산해 다르면 422로 거부합니다. 매핑이 검증되지 않은 정책에서 웹캠 각도를 보내면 `camera_angle_unvalidated`로 거부합니다.
- 브라우저 연결(`frontend/src/features/measurement/camera-pipeline.ts`): 측정·보정 화면에서 카메라가 켜지면 MediaPipe lite를 초당 최대 15번 실행해 `cameraFeatures`를 만들고, 보정 중이면 `advanceCalibration`(3초 안정 구간)에, 아니면 최근 10초 버퍼에 넣습니다. 측정 흐름은 1초 창마다 `observe(start, end)`로 `summarizeCameraWindow` → `cameraObservation` 결과(변화량 또는 실패 이유)만 받습니다. 관절점·특징값과 기준값은 이 모듈 밖으로 나가지 않고 서버로 보내지 않습니다.
- 측정 화면 입력은 "실제 카메라"(웹캠 단독, 기준 자세 필요)와 "테스트 입력"(합성 신호)으로 고릅니다. 실제 카메라의 기준 재설정은 고정 3초가 아니라 보정 상태 기계가 기준을 저장할 때 끝납니다. 정책이 승인되기 전까지 두 입력 모두 `data_source=demo`로 저장합니다.
- 실측 저장(`data_source=real`): 변화량 정책은 웹캠 각도를 만들지 않으므로 카메라 매핑 검증 조건은 적용하지 않고, 팀의 정책 승인(`release_approved`)만 필요합니다. `draft-web-v1`은 아직 미승인입니다(ECOLEPHANT-12).

## AirPods 특징 제안

OS 원본의 pitch 차이를 축·부호 확인 후 `head_flexion_deg = max(0, degrees(pitch - baseline_pitch))`로 정규화합니다. 실제 축·회전 순서·장착 방향·부호는 DEC-003 실측 결과로 확정합니다. yaw·머리 회전이나 몸통과 함께 숙이는 동작을 앞쏠림으로 확정하지 않습니다.

## 보정

1. 선택 센서의 연결·품질·시간 정렬을 확인합니다.
2. 안정 자세를 초기 제안 3초 수집합니다. 연속 안정 구간의 중앙값을 기준으로 저장합니다.
3. 움직임·누락·인식 실패가 있으면 이유를 표시하고 안정 구간을 다시 수집합니다. 안정 허용 편차는 검증 대기입니다.
4. 보정값을 현재 세션·센서에만 적용합니다. 보정은 바른 자세의 의학적 증명이 아닙니다.
5. 장치 위치·화면 각도·착용 위치 변경 후 재보정합니다. 재보정 시작 즉시 이전 기준을 판정에서 제외합니다.

구현(웹캠): `ai/src/camera-features.ts`가 `r`·`h`와 기준 대비 변화를, `ai/src/calibration.ts`가 3초 안정 구간 중앙값 기준을 계산합니다. 두 귀와 두 어깨가 모두 신뢰도 0.7 이상이어야 특징을 만듭니다(코만으로는 `r`을 구할 수 없음). 안정 허용 편차 `|r/중앙값-1| ≤ 0.08`, `|h-중앙값| ≤ 0.06`, 최소 10프레임, 프레임 간격 500ms 초과 시 재시작은 DEC-007 검증 전 초기값입니다. 재시작 이유(`motion`, `missing_points`, `unstable`, `gap` 등)는 화면 안내에 사용합니다. 코 기준값 `n0`는 안정 구간의 절반 이상에서 코가 보였을 때만 저장하고, 아니면 `null`입니다.

보정 실패 시 calibration_epoch는 되돌리지 않습니다. 재보정 성공 전 유효 판정을 재개하지 않습니다. 뒤늦게 연결한 센서는 기준값 없이 결합하지 않습니다.

## 품질과 시간

센서 유효성 → 과도한 회전 제외 → 시계 정렬 → 1초 창별 유효 샘플 비율 확인 → 센서별 대표값 → 판정 순서로 처리합니다. 프레임 수 평균으로 시간 비율을 계산하지 않습니다.

`browser_monotonic_ms`를 기준으로 하고 helper 시계는 핸드셰이크로 정렬합니다. stale 값 재사용, 서로 다른 시점의 값 무제한 결합, 역행 시각 수용을 금지합니다. 창별 최소 유효 커버리지·최대 데이터 나이·허용 시각 차이는 [예시 정책](../../backend/harness/fixtures/policy/example.json)에 제안값으로 모았습니다.

파생 각도의 전송 범위 0~90°는 계약 제안입니다. 범위를 벗어나면 축·단위·매핑 오류를 확인하고 무효 처리하며 최대값으로 조용히 잘라 저장하지 않습니다.

원시 버퍼는 계산에 필요한 구간만 유지하고 종료·권한 해제 시 비웁니다. 센서 복구·보정 epoch·정책 변경 시 평활화와 지속 시간 상태도 초기화합니다. 정책 변경은 활성 세션 도중 허용하지 않으며 새 세션을 만듭니다.
