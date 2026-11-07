import type { Mode } from '@ecolephant/ai';
import type { Metrics, Session } from '../../api/client';
import { formatDuration, modeLabel } from '../../components/ui';

/** 시작~종료 시각으로 세션 길이를 표시합니다. 종료 시각이 없으면 상태에 맞는 문구를 돌려줍니다. */
export function sessionLength(session: Pick<Session, 'started_at' | 'ended_at' | 'status'>) {
  if (!session.ended_at) return session.status === 'active' ? '진행 중' : '길이 알 수 없음';
  const ms = Date.parse(session.ended_at) - Date.parse(session.started_at);
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : '길이 알 수 없음';
}

/** 진행 중(active)과 중단(abandoned)을 구분해 표시합니다. */
export function statusLabel(status: Session['status']) {
  return status === 'completed' ? '완료' : status === 'abandoned' ? '중단' : '미완료';
}

/** 1차 알림 뒤 자세 변화가 확인된 횟수. 알림이 없으면 null. */
export function correctionRatio(metrics: Metrics) {
  if (!metrics.first_stage_alert_count) return null;
  return `${metrics.corrected_alert_count}/${metrics.first_stage_alert_count}회`;
}

export function meanCorrection(metrics: Metrics) {
  return metrics.mean_correction_ms == null ? '—' : formatDuration(metrics.mean_correction_ms);
}

/** 평균 각도는 검증 전 웹캠 값이므로 '추정'으로만 표시합니다. 유효 시간이 없으면 비웁니다. */
export function meanAngle(metrics: Metrics) {
  return metrics.valid_duration_ms > 0 && metrics.mean_display_angle_deg != null
    ? `${metrics.mean_display_angle_deg.toFixed(1)}°`
    : '—';
}

/** 세션 요약(화면·PDF 공용): 핵심 타일 3개, 상태 분포, 나머지 지표 2열 표. */
export function summaryView(metrics: Metrics) {
  const correction = correctionRatio(metrics);
  return {
    tiles: [
      { key: 'valid', label: '유효 측정 시간', value: formatDuration(metrics.valid_duration_ms) },
      {
        key: 'normal',
        label: '정상 비율',
        value:
          metrics.within_range_percent == null
            ? '—'
            : `${metrics.within_range_percent.toFixed(1)}%`,
      },
      {
        key: 'alerts',
        label: '1차 알림',
        value: `${metrics.first_stage_alert_count}회`,
        caption: correction ? `알림 후 자세 변화 ${correction}` : undefined,
      },
    ],
    /** 유효 시간 대비 비율로 막대를 그림. 유효 시간이 0이면 빈 막대 */
    total: metrics.valid_duration_ms,
    parts: [
      { key: 'normal', label: '정상', ms: metrics.normal_duration_ms },
      { key: 'caution', label: '주의', ms: metrics.caution_duration_ms },
      { key: 'high', label: '높음', ms: metrics.high_duration_ms },
    ],
    details: [
      ['평균 각도(추정)', meanAngle(metrics)],
      ['앞쪽 쏠림 의심', formatDuration(metrics.forward_head_suspected_ms)],
      ['알림 후 자세 변화', correction ?? '—'],
      ['평균 변화 시간', meanCorrection(metrics)],
    ],
  } as const;
}

const sensors = { webcam: ['카메라'], airpods: ['AirPods'], combined: ['카메라', 'AirPods'] };

/**
 * 세션 요약 제목. 요청한 방식과 실제로 판정에 쓴 센서가 다르면 왜 나뉘었는지 붙임.
 * 예: 결합으로 측정 중 카메라가 끊긴 구간 → "AirPods (카메라 끊김 구간)"
 */
export function summaryTitle(requested: Mode, active: Mode) {
  if (requested === active) return modeLabel[active];
  const lost = sensors[requested].filter((name) => !sensors[active].includes(name));
  return lost.length ? `${modeLabel[active]} (${lost.join('·')} 끊김 구간)` : modeLabel[active];
}

export function bucketModes(modes: readonly Mode[]) {
  return modes.length ? modes.map((mode) => modeLabel[mode]).join(' · ') : '—';
}
