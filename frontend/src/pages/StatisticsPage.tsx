import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Mode } from '@ecolephant/ai';
import { Bell, ChevronDown, Clock, FileText, HelpCircle, Table2, TrendingUp } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { Select } from '../components/Select';
import { Button, ErrorState, formatDuration, Loading, modeLabel, Notice } from '../components/ui';
import { BarChart, LineChart, SERIES_COLORS } from '../features/statistics/charts';
import { buildStatsView, groupName, showsPolicy, type Unit } from '../features/statistics/model';
import { StateDonut } from '../features/statistics/StateDonut';
import { StatisticsTables } from '../features/history/StatisticsTables';
import { useSeoulDayEnd } from '../features/history/useSeoulDayEnd';

/** 서버 통계 조회는 최대 366일이라 '전체'는 오늘까지 최근 366일 */
const ALL_DAYS = 366;
const dayOptions = [
  { value: String(ALL_DAYS), label: '전체' },
  { value: '1', label: '오늘' },
  { value: '7', label: '7일' },
  { value: '30', label: '30일' },
] as const;
const modeOptions = [
  { value: '', label: '전체' },
  ...(['webcam', 'airpods', 'combined'] as const).map((value) => ({
    value,
    label: modeLabel[value],
  })),
] as { value: Mode | ''; label: string }[];
const unitOptions = [
  { value: 'day', label: '일별' },
  { value: 'hour', label: '시간별' },
] as const;
/** 서버 include_active: 완료만이면 진행 중·중단 세션을 통계에서 뺌 */
const activeOptions = [
  { value: 'true', label: '전체' },
  { value: 'false', label: '완료만' },
] as const;

const rangeDate = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const minutes = (ms: number) => `${Math.round(ms / 60000)}분`;
const percent = (value: number) => `${value.toFixed(1)}%`;

export function StatisticsPage() {
  const [days, setDays] = useState(ALL_DAYS);
  const [mode, setMode] = useState<Mode | ''>('');
  const [unit, setUnit] = useState<Unit>('day');
  const [includeActive, setIncludeActive] = useState<'false' | 'true'>('true');
  const dayEnd = useSeoulDayEnd();
  const range = useMemo(
    () => ({
      from: new Date(dayEnd - days * 86400000).toISOString(),
      to: new Date(dayEnd).toISOString(),
    }),
    [dayEnd, days],
  );
  const stats = useQuery({
    queryKey: ['statistics', range, mode, unit, includeActive],
    queryFn: () =>
      api.statistics({
        ...range,
        group_by: unit,
        timezone: 'Asia/Seoul',
        include_active: includeActive,
        ...(mode ? { mode } : {}),
      }),
  });
  const groups = stats.data?.groups ?? [];
  const unassigned = mode ? 0 : (stats.data?.unassigned_unknown_duration_ms ?? 0);

  const view = useMemo(() => buildStatsView(groups, unit), [groups, unit]);

  const hidden = view.hidden;
  const [pdfState, setPdfState] = useState<'idle' | 'loading' | 'error'>('idle');

  async function savePdf() {
    if (pdfState === 'loading') return;
    setPdfState('loading');
    try {
      const { createStatisticsPdf } = await import('../features/pdf/statistics-report');
      const blob = await createStatisticsPdf({
        filterLabel: [
          days === ALL_DAYS ? '전체 기간' : days === 1 ? '오늘' : `최근 ${days}일`,
          mode ? modeLabel[mode] : '전체 방식',
          unit === 'day' ? '일별' : '시간별',
          ...(includeActive === 'false' ? ['완료 세션만'] : []),
        ].join(' · '),
        rangeLabel: `${rangeDate.format(new Date(range.from))} ~ ${rangeDate.format(new Date(Date.parse(range.to) - 1))}`,
        unit,
        groups,
        unassigned,
        unassignedApplies: !mode,
        view,
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ecolephant-statistics-${range.from.slice(0, 10)}-${days}d.pdf`;
      try {
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setPdfState('idle');
    } catch {
      setPdfState('error');
    }
  }
  const empty = !groups.length && !unassigned;

  return (
    <div className="stats-page">
      <div className="page-heading">
        <div>
          <h1>통계·추이</h1>
          <p className="page-description">
            기간별 측정 시간과 정상 범위 비율이 어떻게 변하는지 확인해요.
          </p>
        </div>
        <Button
          variant="secondary"
          className="session-action"
          onClick={() => void savePdf()}
          disabled={stats.isLoading || stats.isError || pdfState === 'loading'}
        >
          <FileText size={16} aria-hidden="true" />
          {pdfState === 'loading' ? 'PDF 준비 중' : 'PDF로 저장'}
        </Button>
      </div>
      {pdfState === 'error' && (
        <Notice kind="error">PDF를 준비하지 못했습니다. 다시 시도해 주세요.</Notice>
      )}

      <div className="service-controls service-filters">
        <Select
          label="기간"
          value={String(days) as (typeof dayOptions)[number]['value']}
          options={dayOptions}
          onChange={(value) => setDays(Number(value))}
        />
        <Select<Mode | ''> label="방식" value={mode} options={modeOptions} onChange={setMode} />
        <Select<Unit> label="단위" value={unit} options={unitOptions} onChange={setUnit} />
        <Select<'false' | 'true'>
          label="세션 상태"
          value={includeActive}
          options={activeOptions}
          onChange={setIncludeActive}
        />
      </div>

      {stats.isLoading ? (
        <Loading />
      ) : stats.isError ? (
        <ErrorState error={errorMessage(stats.error)} retry={() => void stats.refetch()} />
      ) : empty ? (
        <section className="panel">
          <div className="history-empty">
            <TrendingUp size={28} aria-hidden="true" />
            <p>이 기간에는 통계가 없어요. 측정을 하면 여기에 추이가 나타나요.</p>
          </div>
        </section>
      ) : (
        <>
          <div className="stats-tiles">
            <div className="stats-tile">
              <span>
                <Clock size={16} aria-hidden="true" />
                유효 측정 시간
              </span>
              <strong>{formatDuration(view.totalValid)}</strong>
            </div>
            <div className="stats-tile">
              <span>
                <Bell size={16} aria-hidden="true" />
                1차 알림
              </span>
              <strong>{view.totalAlerts}회</strong>
              {view.totalCorrected != null && (
                <small>알림 후 자세 변화 {view.totalCorrected}회</small>
              )}
            </div>
            <div className="stats-tile">
              <span>
                <HelpCircle size={16} aria-hidden="true" />
                미분류 시간
              </span>
              <strong>{mode ? '—' : formatDuration(unassigned)}</strong>
            </div>
          </div>

          {groups.length > 0 && (
            <section className="panel stats-chart-panel">
              <div className="session-section-head state-donut-head">
                <h2 className="history-section-title">자세 상태 분포</h2>
                <p className="stats-note state-donut-note">
                  유효 측정 시간 기준이에요. 판단 불가 시간은 빠져 있고, 측정 방식·출처·판정 기준이
                  다르면 따로 그려요.
                </p>
              </div>
              <div className="state-donuts">
                {groups.map((group) => (
                  <StateDonut
                    key={`${group.data_source}:${group.active_mode}:${group.policy_id}`}
                    title={
                      showsPolicy(groups)
                        ? `${groupName(group)} · 기준 ${group.policy_id}`
                        : groupName(group)
                    }
                    metrics={group.summary}
                  />
                ))}
              </div>
            </section>
          )}

          {view.labels.length > 0 && (
            <>
              <section className="panel stats-chart-panel">
                <div className="session-section-head">
                  <h2 className="history-section-title">정상 범위 비율 추이</h2>
                  {view.series.length > 1 && (
                    <ul className="stats-legend">
                      {view.series.map((s) => (
                        <li key={s.key}>
                          <i style={{ background: s.color }} aria-hidden="true" />
                          {s.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <LineChart
                  labels={view.labels}
                  series={view.series}
                  format={percent}
                  ariaLabel="정상 범위 비율 추이 차트. 자세한 값은 아래 표에서 확인할 수 있어요."
                />
                {hidden > 0 && (
                  <p className="stats-note">
                    그룹이 많아 처음 {view.series.length}개만 그렸어요. 나머지 {hidden}개는 아래
                    표에서 확인해 주세요.
                  </p>
                )}
                <p className="stats-note">
                  측정 방식·출처·판정 기준이 다르면 비율을 합치지 않고 따로 보여 줘요.
                </p>
              </section>

              <section className="panel stats-chart-panel">
                <h2 className="history-section-title">유효 측정 시간</h2>
                <BarChart
                  points={view.validByStart}
                  color={SERIES_COLORS[0]}
                  format={formatDuration}
                  axisFormat={minutes}
                  ariaLabel="구간별 유효 측정 시간 차트. 자세한 값은 아래 표에서 확인할 수 있어요."
                />
              </section>
            </>
          )}

          <details className="panel stats-table-panel">
            <summary>
              <Table2 size={18} aria-hidden="true" />
              표로 보기
              <span className="stats-table-toggle" aria-hidden="true">
                <ChevronDown size={18} />
              </span>
            </summary>
            <div className="history-page stats-table-body">
              <StatisticsTables groups={groups} unit={unit} unassigned={unassigned} range={range} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
