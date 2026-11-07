import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useRouter, useSearch } from '@tanstack/react-router';
import { BarChart3, ChevronLeft, Clock, Inbox, ListChecks } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { Button, ErrorState, formatDuration, Loading } from '../components/ui';
import { SessionSummary } from '../features/history/SessionSummary';
import { SessionRows } from '../features/history/SessionRows';
import { StatisticsTables } from '../features/history/StatisticsTables';
import { groupName, showsPolicy } from '../features/statistics/model';
import {
  periodKind,
  periodSubtitle,
  periodTitle,
  type PeriodSearch,
} from '../features/statistics/period';

/** 통계 '기간별' 표의 한 행(하루 또는 한 시간)을 자세히 보는 페이지 */
export function StatisticsPeriodPage() {
  const search = useSearch({ strict: false }) as Partial<PeriodSearch>;
  const router = useRouter();
  if (!search.from || !search.to) {
    return (
      <div className="empty-state">
        <h1>기간을 찾을 수 없어요.</h1>
        <Link to="/statistics">통계·추이로 돌아가기</Link>
      </div>
    );
  }
  const period = { from: search.from, to: search.to, mode: search.mode };
  return <PeriodDetail period={period} onBack={() => router.history.back()} />;
}

function PeriodDetail({ period, onBack }: { period: PeriodSearch; onBack: () => void }) {
  const kind = periodKind(period);
  // 하루는 시간대별, 여러 날은 일별로 나눠 보여 줌
  const unit = kind === 'range' ? 'day' : 'hour';
  const filter = {
    from: period.from,
    to: period.to,
    ...(period.mode ? { mode: period.mode } : {}),
  };
  const stats = useQuery({
    queryKey: ['statistics', 'period', filter, unit],
    queryFn: () =>
      api.statistics({ ...filter, group_by: unit, timezone: 'Asia/Seoul', include_active: 'true' }),
  });
  const sessions = useInfiniteQuery({
    queryKey: ['sessions', 'period', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.sessions({ ...filter, limit: 20, cursor: pageParam, order: 'desc' }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const groups = stats.data?.groups ?? [];
  const policy = showsPolicy(groups);
  const unassigned = period.mode ? 0 : (stats.data?.unassigned_unknown_duration_ms ?? 0);
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="history-page session-page">
      <button type="button" className="back-link" onClick={onBack}>
        <ChevronLeft size={16} aria-hidden="true" />
        돌아가기
      </button>
      <div className="page-heading">
        <div>
          <h1>{periodTitle(period)} 통계</h1>
          <p className="page-description">
            {periodSubtitle(period)} ·{' '}
            {kind === 'hour' ? '한 시간' : kind === 'day' ? '하루' : '이 기간'} 동안의 측정
            결과예요.
          </p>
        </div>
      </div>

      <section className="panel service-panel">
        <h2 className="history-section-title">
          <BarChart3 size={18} aria-hidden="true" />
          요약
        </h2>
        {stats.isLoading ? (
          <Loading />
        ) : stats.isError ? (
          <ErrorState error={errorMessage(stats.error)} retry={() => void stats.refetch()} />
        ) : groups.length ? (
          <div className="session-summaries">
            {groups.map((group) => (
              <SessionSummary
                key={`${group.data_source}:${group.active_mode}:${group.policy_id}`}
                mode={group.active_mode}
                metrics={group.summary}
                title={policy ? `${groupName(group)} · 기준 ${group.policy_id}` : groupName(group)}
              />
            ))}
          </div>
        ) : (
          <p className="service-note">이 기간에는 통계가 없어요.</p>
        )}
        {unassigned > 0 && <p className="service-note">미분류 시간 {formatDuration(unassigned)}</p>}
      </section>

      {kind !== 'hour' && groups.length > 0 && (
        <section className="panel service-panel">
          <h2 className="history-section-title">
            <Clock size={18} aria-hidden="true" />
            {unit === 'day' ? '일별' : '시간대별'}
          </h2>
          <StatisticsTables groups={groups} unit={unit} unassigned={0} showTotal={false} />
        </section>
      )}

      <section className="panel service-panel">
        <h2 className="history-section-title">
          <ListChecks size={18} aria-hidden="true" />이 기간에 시작한 세션
        </h2>
        {sessions.isLoading ? (
          <Loading />
        ) : sessions.isError && !sessions.data ? (
          <ErrorState error={errorMessage(sessions.error)} retry={() => void sessions.refetch()} />
        ) : items.length ? (
          <SessionRows items={items} />
        ) : (
          <div className="history-empty">
            <Inbox size={28} aria-hidden="true" />
            <p>이 기간에 시작한 세션이 없어요. 이전에 시작해 이어진 측정일 수 있어요.</p>
          </div>
        )}
        {sessions.isFetchNextPageError ? (
          <ErrorState
            error={errorMessage(sessions.error)}
            retry={() => void sessions.fetchNextPage()}
          />
        ) : (
          sessions.hasNextPage && (
            <Button
              variant="secondary"
              disabled={sessions.isFetchingNextPage}
              onClick={() => void sessions.fetchNextPage()}
            >
              더 보기
            </Button>
          )
        )}
      </section>
    </div>
  );
}
