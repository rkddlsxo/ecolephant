# 센서 결합과 판정 규칙

이 문서는 PDF의 결합 표를 보존하고 빠진 구간을 설계 제안으로 채웁니다. 전체 프로필은 **검증 대기**이며 임상 진단 기준으로 사용하지 않습니다.

## 출력 의미

- `posture_level`: `normal/caution/high/unknown`. high는 관측된 자세 신호 수준이며 의료 진단이 아닙니다.
- `reason_code`: `within_range/combined_high/forward_shift/head_flexion/mixed_caution/insufficient_data/motion/calibrating/paused`.
- `display_angle_deg`: 참고 종합값. 센서별 추정치의 가중 평균이며 판정을 단독 결정하지 않습니다.
- `confidence`: `dual_sensor/single_sensor/unavailable`. 검증된 정확도 확률이 아닌 관측 센서 범위입니다.

## 구간과 결합 표

경계 포함은 설계 제안으로 `0 ≤ x < 15`, `15 ≤ x < 30`, `30 ≤ x ≤ 90`으로 정합니다. 음수 숙임은 정규화 시 0으로 처리하되 원시 부호 검증을 먼저 수행합니다. 이 정규화는 판정 전 단계인 `ai/src/head-motion.ts`의 `headFlexionDeg()`가 맡습니다. 판정(`deriveWindow`)에 들어온 값이 0~90을 벗어나면 축·단위·매핑 오류로 보고 무효 처리하며, 0이나 90으로 잘라 쓰지 않습니다.

| 웹캠 추정 | 머리 숙임 | level | reason | 출처 상태 |
|---|---|---|---|---|
| 30 이상 | 30 이상 | high | combined_high | 원문 |
| 30 이상 | 15 미만 | high | forward_shift | 원문 |
| 15 미만 | 30 이상 | caution | head_flexion | 원문 |
| 15 미만 | 15 미만 | normal | within_range | 설계 제안 |
| 30 이상 | 15 이상 30 미만 | high | forward_shift | 설계 제안 |
| 15 이상 30 미만 | 임의의 유효 값 | caution | mixed_caution | 설계 제안 |
| 15 미만 | 15 이상 30 미만 | caution | mixed_caution | 설계 제안 |

웹캠만이면 웹캠 추정 구간으로 level을 정하고 high의 reason은 forward_shift입니다. AirPods만이면 숙임 구간으로 level을 정하고 caution/high의 reason은 head_flexion입니다. AirPods만의 high는 화면에서 ‘고개 숙임 큼’으로 표시합니다. 결합 모드의 head_flexion/caution도 지속 알림 대상이 될 수 있습니다. 이 명칭과 단일 센서 규칙은 DEC-004 합의 대상입니다.

## 참고 종합값

두 센서가 유효하면 초기 가중치 0.5:0.5로 계산합니다. 예를 들어 웹캠 40°, AirPods 5°이면 참고값은 22.5°이지만 level은 high, 이유는 forward_shift입니다. UI에 ‘센서 조합 판정’과 두 값을 보여주어 의미를 설명합니다. 숫자만으로 상태를 재계산하지 않습니다.

단일 센서는 해당 센서 값만 표시합니다. 무효 창에서는 모든 각도를 null, posture_level을 unknown, confidence를 unavailable로 둡니다. 0°로 누락을 표현하지 않습니다.

## 동작과 품질 우선순위

1. paused·calibrating이면 해당 품질로 출력합니다.
2. 과도한 회전 구간이면 motion/unknown으로 출력합니다.
3. 유효 센서와 보정이 없으면 no_sensor 또는 low_confidence/unknown입니다.
4. 남은 센서가 유효하면 모드를 바꾸고 그 센서 규칙을 적용합니다.
5. 현재 정책으로 level과 reason을 계산하고 [알림 정책](notifications.md)에 전달합니다.

높은 값을 평활화로 임의 제거하거나 짧은 이상을 정상 시간으로 재분류하지 않습니다. 알림 인정 최소 시간과 자세 상태·시간 집계는 다른 개념입니다.
