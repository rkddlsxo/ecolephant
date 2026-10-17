import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, CalendarDays, Clock3, FolderHeart } from 'lucide-react';
import type { Mode } from '@ecolephant/ai';
import { api, errorMessage } from '../api/client';
import {
  Button,
  ErrorState,
  formatDate,
  formatDuration,
  Loading,
  modeLabel,
  Notice,
} from '../components/ui';
import { MetricCards } from '../components/MetricCards';

export function HistoryPage() {
  const [days, setDays] = useState(7);
  const [mode, setMode] = useState<Mode | ''>('');
  const range = useMemo(() => {
    const now = new Date(Date.now() + 9 * 3600000);
    const midnight =
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - 9 * 3600000;
    return {
      from: new Date(midnight - days * 86400000).toISOString(),
      to: new Date(midnight).toISOString(),
    };
  }, [days]);
  const sessions = useInfiniteQuery({
    queryKey: ['sessions', range, mode],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.sessions({ ...range, mode: mode || undefined, limit: 20, cursor: pageParam }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const stats = useQuery({
    queryKey: ['statistics', range, mode],
    queryFn: () =>
      api.statistics({
        ...range,
        group_by: 'day',
        timezone: 'Asia/Seoul',
        ...(mode ? { mode } : {}),
      }),
  });
  const items =
    sessions.data?.pages
      .flatMap((p) => p.items)
      .slice()
      .reverse() ?? [];
  const groups = stats.data?.groups ?? [];
  const valid = groups.reduce((total, g) => total + g.summary.valid_duration_ms, 0);
  const alerts = groups.reduce((total, g) => total + g.summary.first_stage_alert_count, 0);
  return (
    <div>
      <div className="page-heading">
        <div>
          <span className="eyebrow">차곡차곡 쌓이는 나의 루틴</span>
          <h1>자세 기록</h1>
          <p>종료·저장된 예시 기록으로 화면 흐름을 확인해 보세요.</p>
        </div>
        <span className="badge outline">
          <CalendarDays size={15} />
          Asia/Seoul
        </span>
      </div>
      <div className="filter-bar">
        <div className="segmented">
          {[7, 30].map((value) => (
            <button
              key={value}
              className={days === value ? 'selected' : ''}
              onClick={() => setDays(value)}
            >
              최근 {value}일
            </button>
          ))}
        </div>
        <label className="inline-label">
          측정 방식
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode | '')}>
            <option value="">전체 방식</option>
            {(['combined', 'webcam', 'airpods'] as const).map((m) => (
              <option key={m} value={m}>
                {modeLabel[m]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {stats.isError && (
        <ErrorState error={errorMessage(stats.error)} retry={() => void stats.refetch()} />
      )}
      <MetricCards
        cards={[
          {
            id: 'valid',
            label: '유효 측정 시간',
            value: stats.isLoading || stats.isError ? '—' : formatDuration(valid),
            help: '완료된 세션 · 판단 불가 제외',
          },
          {
            id: 'range',
            label: groups.length === 1 ? '기준 범위 비율' : '측정 그룹',
            value:
              stats.isLoading || stats.isError
                ? '—'
                : groups.length === 1
                  ? groups[0].summary.within_range_percent == null
                    ? '—'
                    : `${groups[0].summary.within_range_percent.toFixed(1)}%`
                  : `${groups.length}개`,
            help:
              groups.length === 1
                ? '같은 방식·정책의 유효 시간 기준'
                : '방식과 정책이 다른 평균은 구분해요',
          },
          {
            id: 'alerts',
            label: '전달된 1차 알림',
            value: stats.isLoading || stats.isError ? '—' : `${alerts}회`,
            help: '중복·2차·전달 실패 제외',
          },
        ]}
      />
      <section className="panel history-chart">
        <div className="section-heading">
          <div>
            <h2>기간별 자세 구성</h2>
            <p>동일 방식과 정책별로 구분한 서버 집계입니다.</p>
          </div>
          <span className="badge neutral">데모 기록</span>
        </div>
        {groups.length ? (
          groups.map((group) => (
            <div className="group-chart" key={`${group.active_mode}:${group.policy_id}`}>
              <strong>
                {modeLabel[group.active_mode]}
                <small>{group.policy_id}</small>
              </strong>
              <div className="bar-list">
                {group.buckets.map((bucket) => {
                  const m = bucket.metrics,
                    total = m.valid_duration_ms;
                  return (
                    <div className="bar-row" key={bucket.starts_at}>
                      <span>
                        {new Date(bucket.starts_at).toLocaleDateString('ko-KR', {
                          month: 'numeric',
                          day: 'numeric',
                          timeZone: 'Asia/Seoul',
                        })}
                      </span>
                      <div
                        className="stacked-bar"
                        aria-label={`유효 ${formatDuration(total)}`}
                        title={`기준 범위 ${formatDuration(m.normal_duration_ms)} / 주의 ${formatDuration(m.caution_duration_ms)} / 높음 ${formatDuration(m.high_duration_ms)}`}
                      >
                        <i
                          className="normal"
                          style={{
                            width: total ? `${(m.normal_duration_ms / total) * 100}%` : '0%',
                          }}
                        />
                        <i
                          className="caution"
                          style={{
                            width: total ? `${(m.caution_duration_ms / total) * 100}%` : '0%',
                          }}
                        />
                        <i
                          className="high"
                          style={{ width: total ? `${(m.high_duration_ms / total) * 100}%` : '0%' }}
                        />
                      </div>
                      <small>{formatDuration(total)}</small>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        ) : (
          <div className="empty-chart">
            {stats.isLoading ? '통계를 불러오고 있어요.' : '완료된 데모 측정이 아직 없어요.'}
          </div>
        )}
        <div className="legend">
          <span className="legend-normal">기준 범위</span>
          <span className="legend-caution">주의</span>
          <span className="legend-high">높은 신호</span>
        </div>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>측정 세션</h2>
            <p>미완료 세션은 기간 통계에 포함하지 않습니다.</p>
          </div>
          <span className="count-badge">{items.length}개 불러옴</span>
        </div>
        {sessions.isLoading ? (
          <Loading />
        ) : sessions.isError ? (
          <ErrorState error={errorMessage(sessions.error)} retry={() => void sessions.refetch()} />
        ) : items.length ? (
          <div className="session-list">
            {items.map((session) => (
              <Link
                key={session.id}
                to="/history/$sessionId"
                params={{ sessionId: session.id }}
                className="session-row"
              >
                <span className="session-icon">
                  <Clock3 size={22} />
                </span>
                <div>
                  <strong>{formatDate(session.started_at)}</strong>
                  <small>
                    {modeLabel[session.requested_mode]} ·{' '}
                    {session.ended_at
                      ? formatDuration(
                          Date.parse(session.ended_at) - Date.parse(session.started_at),
                        )
                      : '종료되지 않은 기록'}
                  </small>
                </div>
                <span className={`badge ${session.status === 'completed' ? 'success' : 'warning'}`}>
                  {session.status === 'completed' ? '저장 완료' : '미완료'}
                </span>
                <span className="badge neutral">데모</span>
                <ArrowUpRight size={18} />
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <FolderHeart size={40} />
            <h3>첫 번째 기록을 기다리고 있어요.</h3>
            <p>준비 화면에서 데모를 시작하고 종료해 보세요.</p>
            <Link to="/" className="button button-primary">
              데모 시작하기
            </Link>
          </div>
        )}
        {sessions.hasNextPage && (
          <Button
            variant="secondary"
            disabled={sessions.isFetchingNextPage}
            onClick={() => void sessions.fetchNextPage()}
          >
            기록 더 보기
          </Button>
        )}
      </section>
      <Notice>
        이 버전의 모든 기록은 합성 입력으로 생성됩니다. 실제 웹캠 추정 정확도와 AirPods 연동은 아직
        검증되지 않았습니다.
      </Notice>
    </div>
  );
}
