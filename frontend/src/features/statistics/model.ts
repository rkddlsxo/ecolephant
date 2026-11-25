import { policy } from '@ecolephant/ai';
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
/**
 * 지금 판정 기준으로 잰 묶음과 이전 기준 묶음으로 나눈다. 이전 기록을 새 기준으로 다시 판정할
 * 구간 값은 프론트에서 받을 수 없어서, 분포 도넛은 현재 기준 묶음만 그린다.
 */
export function splitByPolicy(groups: Group[], current: string = policy.policy_id) {
  const latest = groups.filter((g) => g.policy_id === current);
  const older = groups.filter((g) => g.policy_id !== current);
  const olderValidMs = older.reduce((sum, g) => sum + g.summary.valid_duration_ms, 0);
  return { current: latest, older, olderValidMs };
}
export type StatsView = {
  labels: { x: string; label: string }[];
  series: Series[];
  validByStart: Point[];
  totalValid: number;
  totalAlerts: number;
  /** 알림 후 자세 변화가 확인된 횟수. 알림이 없으면 null */
  totalCorrected: number | null;
  /** 추이 그래프의 x축. 선으로 그린 그룹에 기록이 있는 구간만 담는다. */
  trendLabels: { x: string; label: string }[];
  /** 이전 판정 기준이라 추이 선에서 뺀 그룹 수 */
  olderPolicies: number;
};

/**
 * 측정 방식(과 출처)마다 가장 최근 판정 기준 그룹 하나만 남긴다. 가장 최근 기준은 그 방식에서
 * 마지막 버킷이 가장 늦은 그룹의 기준이다. 판정 기준이 다르면 비율을 이어 그릴 수 없어서다.
 */
export function latestPolicyPerMode(groups: Group[]) {
  const latest = new Map<string, { group: Group; at: number }>();
  for (const group of groups) {
    const last = group.buckets.at(-1);
    if (!last) continue;
    const key = `${group.data_source}:${group.active_mode}`;
    const at = Date.parse(last.starts_at);
    const best = latest.get(key);
    if (!best || at > best.at) latest.set(key, { group, at });
  }
  const kept = new Set([...latest.values()].map((v) => v.group));
  return groups.filter((g) => kept.has(g));
}

/** 추이 그래프 아래 안내 문구 (줄 단위). 화면과 PDF가 같은 문장을 쓴다. */
export function trendNote(view: StatsView) {
  if (view.olderPolicies === 0) return null;
  return [
    '측정 방식마다 가장 최근 판정 기준으로 잰 기록만 그렸어요.',
    '이전 기준 기록은 기준이 달라 이어 그릴 수 없어서, 아래 표에서 확인해 주세요.',
  ];
}

/** 화면과 PDF가 같은 숫자를 쓰도록 통계 응답을 차트용으로 정리한다. */
export function buildStatsView(groups: Group[], unit: Unit): StatsView {
  const starts = [...new Set(groups.flatMap((g) => g.buckets.map((b) => b.starts_at)))].sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  );
  const format = unit === 'day' ? dayLabel : hourLabel;
  const labels = starts.map((x) => ({ x, label: format.format(new Date(x)) }));
  // 측정 방식마다 선 하나. 방식끼리는 비율을 합치지 않고, 이전 판정 기준 기록은 뺀다.
  const lineGroups = latestPolicyPerMode(groups);
  const lineStarts = new Set(lineGroups.flatMap((g) => g.buckets.map((b) => b.starts_at)));
  const trendLabels = labels.filter((l) => lineStarts.has(l.x));
  const series: Series[] = lineGroups.map((group, index) => {
    const byStart = new Map(group.buckets.map((b) => [b.starts_at, b.metrics]));
    return {
      key: groupKey(group),
      name: groupName(group),
      color: SERIES_COLORS[index % SERIES_COLORS.length]!,
      points: trendLabels.map(({ x, label }) => {
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
    trendLabels,
    olderPolicies: groups.length - lineGroups.length,
  };
}
