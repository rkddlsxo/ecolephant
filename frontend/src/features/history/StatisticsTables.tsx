import type { Metrics, Statistics } from '../../api/client';
import { formatDuration, modeLabel } from '../../components/ui';

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

function GroupName({ group }: { group: Group }) {
  return (
    <>
      {modeLabel[group.active_mode]} · {group.data_source === 'real' ? '실제' : '테스트'} · 기준{' '}
      {group.policy_id}
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
      <td>{formatDuration(metrics.valid_duration_ms)}</td>
      <td>{normal === null ? '—' : `${normal.toFixed(1)}%`}</td>
      <td>{high === null ? '—' : `${high.toFixed(1)}%`}</td>
      <td>{metrics.first_stage_alert_count}회</td>
    </>
  );
}

function MetricHeadings() {
  return (
    <>
      <th>유효 시간</th>
      <th>정상 비율</th>
      <th>높은 신호 비율</th>
      <th>알림</th>
    </>
  );
}

export function StatisticsTables({
  groups,
  unit,
  unassigned,
}: {
  groups: Group[];
  unit: Unit;
  unassigned: number;
}) {
  const buckets = groups.flatMap((group) => group.buckets.map((bucket) => ({ group, bucket })));
  buckets.sort((a, b) => Date.parse(b.bucket.starts_at) - Date.parse(a.bucket.starts_at));
  return (
    <>
      {groups.length > 0 && (
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
                  <tr key={`${group.data_source}:${group.active_mode}:${group.policy_id}`}>
                    <td>
                      <GroupName group={group} />
                    </td>
                    <MetricCells metrics={group.summary} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>기간별</h3>
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
                    >
                      <td>
                        {(unit === 'day' ? dateFormatter : hourFormatter).format(
                          new Date(bucket.starts_at),
                        )}
                      </td>
                      <td>
                        <GroupName group={group} />
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
