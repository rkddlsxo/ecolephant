import type { Mode } from '@ecolephant/ai';
import { modeLabel } from '../../components/ui';

/** 통계 '기간별' 행 하나에 해당하는 상세 통계 페이지 주소 값 */
export type PeriodSearch = { from: string; to: string; mode?: Mode };

const modes: readonly string[] = ['webcam', 'airpods', 'combined'];

export function parsePeriodSearch(search: Record<string, unknown>): Partial<PeriodSearch> {
  const from = typeof search.from === 'string' ? search.from : undefined;
  const to = typeof search.to === 'string' ? search.to : undefined;
  const valid = from && to && Date.parse(from) < Date.parse(to);
  const mode =
    typeof search.mode === 'string' && modes.includes(search.mode)
      ? (search.mode as Mode)
      : undefined;
  return { ...(valid ? { from, to } : {}), ...(mode ? { mode } : {}) };
}

/** 한 시간 · 하루 · 여러 날(전체 통계 행) 구간을 구분 */
export function periodKind(period: PeriodSearch): 'hour' | 'day' | 'range' {
  const span = Date.parse(period.to) - Date.parse(period.from);
  return span <= 3600000 ? 'hour' : span <= 86400000 ? 'day' : 'range';
}

const dayFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});
const hourFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
});

/** 예: "11월 6일 (목)", 한 시간이면 "11월 6일 오후 2시", 여러 날이면 "11월 1일 (토) ~ 11월 7일 (금)" */
export function periodTitle(period: PeriodSearch) {
  const kind = periodKind(period);
  if (kind === 'hour') return hourFormat.format(new Date(period.from));
  if (kind === 'day') return dayFormat.format(new Date(period.from));
  // to는 포함하지 않는 끝 시각이라 마지막 날은 1ms 앞으로 표시
  return `${dayFormat.format(new Date(period.from))} ~ ${dayFormat.format(new Date(Date.parse(period.to) - 1))}`;
}

export function periodSubtitle(period: PeriodSearch) {
  return period.mode ? `${modeLabel[period.mode]} 방식` : '전체 방식';
}
