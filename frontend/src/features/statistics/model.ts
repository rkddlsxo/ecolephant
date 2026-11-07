import type { Statistics } from '../../api/client';
import { modeLabel } from '../../components/ui';
import { SERIES_COLORS, type Point, type Series } from './charts';

export type Group = Statistics['groups'][number];
export type Unit = Statistics['group_by'];

const dayLabel = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
});
const hourLabel = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  hourCycle: 'h23',
});

export function groupKey(group: Group) {
  return `${group.data_source}:${group.active_mode}:${group.policy_id}`;
}
export function groupName(group: Group) {
  return `${modeLabel[group.active_mode]} · ${group.data_source === 'real' ? '실제' : '테스트'}`;
}
/** 판정 기준이 하나뿐이면 정책 ID는 구분에 도움이 안 되므로, 둘 이상 섞였을 때만 표시한다. */
export function showsPolicy(groups: Group[]) {
  return new Set(groups.map((g) => g.policy_id)).size > 1;
}
export type StatsView = {
  labels: { x: string; label: string }[];
  series: Series[];
  validByStart: Point[];
  totalValid: number;
  totalAlerts: number;
  /** 알림 후 자세 변화가 확인된 횟수. 알림이 없으면 null */
  totalCorrected: number | null;
  hidden: number;
};

/** 화면과 PDF가 같은 숫자를 쓰도록 통계 응답을 차트용으로 정리한다. */
export function buildStatsView(groups: Group[], unit: Unit): StatsView {
  const starts = [...new Set(groups.flatMap((g) => g.buckets.map((b) => b.starts_at)))].sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  );
  const format = unit === 'day' ? dayLabel : hourLabel;
  const labels = starts.map((x) => ({ x, label: format.format(new Date(x)) }));
  // 정책·방식·출처가 다른 그룹의 비율은 합치지 않고 계열로 나눠 보여 줌 (최대 3개)
  const series: Series[] = groups.slice(0, SERIES_COLORS.length).map((group, index) => {
    const byStart = new Map(group.buckets.map((b) => [b.starts_at, b.metrics]));
    return {
      key: groupKey(group),
      name: groupName(group),
      color: SERIES_COLORS[index]!,
      points: labels.map(({ x, label }) => {
        const metrics = byStart.get(x);
        return {
          x,
          label,
          value:
            metrics && metrics.valid_duration_ms > 0
              ? (metrics.within_range_percent ?? null)
              : null,
        };
      }),
    };
  });
  // 시간과 알림 횟수는 더할 수 있는 값이라 합산
  const validByStart = labels.map(({ x, label }) => ({
    x,
    label,
    value: groups.reduce(
      (sum, g) => sum + (g.buckets.find((b) => b.starts_at === x)?.metrics.valid_duration_ms ?? 0),
      0,
    ),
  }));
  const totalValid = groups.reduce((sum, g) => sum + g.summary.valid_duration_ms, 0);
  const totalAlerts = groups.reduce((sum, g) => sum + g.summary.first_stage_alert_count, 0);
  const totalCorrected = totalAlerts
    ? groups.reduce((sum, g) => sum + g.summary.corrected_alert_count, 0)
    : null;
  return {
    labels,
    series,
    validByStart,
    totalValid,
    totalAlerts,
    totalCorrected,
    hidden: groups.length - series.length,
  };
}
