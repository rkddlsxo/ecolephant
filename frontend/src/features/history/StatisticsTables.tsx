import type { KeyboardEvent } from 'react';
import type { Mode } from '@ecolephant/ai';
import type { Metrics, Statistics } from '../../api/client';
import { formatDuration, modeLabel } from '../../components/ui';
import { correctionRatio, meanCorrection } from './format';
import { showsPolicy } from '../statistics/model';
import { useNavigate } from '@tanstack/react-router';

type Group = Statistics['groups'][number];
type Unit = Statistics['group_by'];

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});
const hourFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function GroupName({ group, policy }: { group: Group; policy: boolean }) {
  return (
    <>
      {modeLabel[group.active_mode]} · {group.data_source === 'real' ? '실제' : '테스트'}
      {policy && ` · 기준 ${group.policy_id}`}
    </>
  );
}

function MetricCells({ metrics }: { metrics: Metrics }) {
  const normal = metrics.valid_duration_ms > 0 ? metrics.within_range_percent : null;
  const high =
    metrics.valid_duration_ms > 0
      ? (metrics.high_duration_ms / metrics.valid_duration_ms) * 100
      : null;
  return (
    <>
      <td className="metric-col">{formatDuration(metrics.valid_duration_ms)}</td>
      <td className="metric-col">{normal === null ? '—' : `${normal.toFixed(1)}%`}</td>
      <td className="metric-col">{high === null ? '—' : `${high.toFixed(1)}%`}</td>
      <td className="metric-col">{metrics.first_stage_alert_count}회</td>
      <td className="metric-col">{correctionRatio(metrics) ?? '—'}</td>
      <td className="metric-col">{meanCorrection(metrics)}</td>
    </>
  );
}

function MetricHeadings() {
  return (
    <>
      <th className="metric-col">유효 시간</th>
      <th className="metric-col">정상 비율</th>
      <th className="metric-col">높은 신호 비율</th>
      <th className="metric-col">알림</th>
      <th className="metric-col">알림 후 자세 변화</th>
      <th className="metric-col">평균 변화 시간</th>
    </>
  );
}

/** 행 전체를 눌러(또는 Enter) 해당 기간·방식의 상세 통계로 이동합니다. */
function rowLink(label: string, open: () => void) {
  return {
    className: 'is-clickable',
    tabIndex: 0,
    title: label,
    onClick: open,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') open();
    },
  };
}

export function StatisticsTables({
  groups,
  unit,
  unassigned,
  showTotal = true,
  range,
}: {
  groups: Group[];
  unit: Unit;
  unassigned: number;
  /** false면 '전체' 표 없이 기간별 표만 (상세 통계 페이지에서 요약과 겹치지 않게) */
  showTotal?: boolean;
  /** 조회한 전체 기간. 있으면 '전체' 표의 행을 눌러 이 기간의 상세 통계를 엶 */
  range?: { from: string; to: string };
}) {
  const navigate = useNavigate();
  const openPeriod = (from: string, to: string, mode: Mode) =>
    void navigate({ to: '/statistics/period', search: { from, to, mode } });
  const buckets = groups.flatMap((group) => group.buckets.map((bucket) => ({ group, bucket })));
  buckets.sort((a, b) => Date.parse(b.bucket.starts_at) - Date.parse(a.bucket.starts_at));
  const policy = showsPolicy(groups);
  return (
    <>
      {groups.length > 0 && (
        <>
          {showTotal && (
            <>
              <h3>전체</h3>
              <div className="service-table-wrap">
                <table className="service-table" aria-label="전체 통계">
                  <thead>
                    <tr>
                      <th>방식</th>
                      <MetricHeadings />
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => (
                      <tr
                        key={`${group.data_source}:${group.active_mode}:${group.policy_id}`}
                        {...(range
                          ? rowLink(`${modeLabel[group.active_mode]} 전체 통계 보기`, () =>
                              openPeriod(range.from, range.to, group.active_mode),
                            )
                          : {})}
                      >
                        <td>
                          <GroupName group={group} policy={policy} />
                        </td>
                        <MetricCells metrics={group.summary} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {showTotal && <h3>기간별</h3>}
          {buckets.length > 0 ? (
            <div className="service-table-wrap">
              <table className="service-table" aria-label="기간별 통계">
                <thead>
                  <tr>
                    <th>기간</th>
                    <th>방식</th>
                    <MetricHeadings />
                  </tr>
                </thead>
                <tbody>
                  {buckets.map(({ group, bucket }) => (
                    <tr
                      key={`${bucket.starts_at}:${bucket.ends_at}:${group.data_source}:${group.active_mode}:${group.policy_id}`}
                      {...rowLink(
                        `${(unit === 'day' ? dateFormatter : hourFormatter).format(new Date(bucket.starts_at))} ${modeLabel[group.active_mode]} 통계 보기`,
                        () => openPeriod(bucket.starts_at, bucket.ends_at, group.active_mode),
                      )}
                    >
                      <td>
                        {(unit === 'day' ? dateFormatter : hourFormatter).format(
                          new Date(bucket.starts_at),
                        )}
                      </td>
                      <td>
                        <GroupName group={group} policy={policy} />
                      </td>
                      <MetricCells metrics={bucket.metrics} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="service-note">기간별 기록 없음</p>
          )}
        </>
      )}
      {unassigned > 0 && <p className="service-note">미분류 시간 {formatDuration(unassigned)}</p>}
      {!groups.length && !unassigned && <p className="service-note">기록 없음</p>}
    </>
  );
}
