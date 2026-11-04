import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Mode } from '@ecolephant/ai';
import { api, errorMessage } from '../api/client';
import type { Statistics } from '../api/client';
import { StatisticsTables } from '../features/history/StatisticsTables';
import { useSeoulDayEnd } from '../features/history/useSeoulDayEnd';
import { Button, ErrorState, formatDate, Loading, modeLabel } from '../components/ui';

export function HistoryPage() {
  const [days, setDays] = useState(7);
  const [mode, setMode] = useState<Mode | ''>('');
  const [unit, setUnit] = useState<Statistics['group_by']>('day');
  const dayEnd = useSeoulDayEnd();
  const range = useMemo(() => {
    return {
      from: new Date(dayEnd - days * 86400000).toISOString(),
      to: new Date(dayEnd).toISOString(),
    };
  }, [dayEnd, days]);
  const sessions = useInfiniteQuery({
    queryKey: ['sessions', range, mode],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.sessions({
        ...range,
        mode: mode || undefined,
        limit: 20,
        cursor: pageParam,
        order: 'desc',
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const stats = useQuery({
    queryKey: ['statistics', range, mode, unit],
    queryFn: () =>
      api.statistics({
        ...range,
        group_by: unit,
        timezone: 'Asia/Seoul',
        ...(mode ? { mode } : {}),
      }),
  });
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  const groups = stats.data?.groups ?? [];
  return (
    <div>
      <div className="page-heading">
        <h1>기록</h1>
      </div>
      <div className="service-controls service-filters">
        <label>
          기간
          <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
            <option value={1}>오늘</option>
            <option value={7}>7일</option>
            <option value={30}>30일</option>
          </select>
        </label>
        <label>
          방식
          <select value={mode} onChange={(event) => setMode(event.target.value as Mode | '')}>
            <option value="">전체</option>
            {(['webcam', 'airpods', 'combined'] as const).map((value) => (
              <option key={value} value={value}>
                {modeLabel[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          단위
          <select
            value={unit}
            onChange={(event) => setUnit(event.target.value as Statistics['group_by'])}
          >
            <option value="day">일별</option>
            <option value="hour">시간별</option>
          </select>
        </label>
      </div>
      <section className="panel service-panel">
        <h2>통계</h2>
        {stats.isLoading ? (
          <Loading />
        ) : stats.isError ? (
          <ErrorState error={errorMessage(stats.error)} retry={() => void stats.refetch()} />
        ) : (
          <StatisticsTables
            groups={groups}
            unit={unit}
            unassigned={mode ? 0 : (stats.data?.unassigned_unknown_duration_ms ?? 0)}
          />
        )}
      </section>
      <section className="panel service-panel">
        <h2>세션</h2>
        {sessions.isLoading ? (
          <Loading />
        ) : sessions.isError && !sessions.data ? (
          <ErrorState error={errorMessage(sessions.error)} retry={() => void sessions.refetch()} />
        ) : items.length ? (
          <div className="service-list">
            {items.map((session) => (
              <Link
                key={session.id}
                to="/history/$sessionId"
                params={{ sessionId: session.id }}
                className="service-list-row"
              >
                <span>{formatDate(session.started_at)}</span>
                <span>{modeLabel[session.requested_mode]}</span>
                <span>{session.status === 'completed' ? '완료' : '미완료'}</span>
                <span className="badge neutral">
                  {session.data_source === 'real' ? '실제' : '테스트'}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="service-note">기록 없음</p>
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
