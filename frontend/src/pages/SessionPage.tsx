import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { api, errorMessage } from '../api/client';
import type { SessionEvent } from '../api/client';
import type { components } from '../api/generated';
import { useMeasurement } from '../state/measurement';
import {
  Button,
  ErrorState,
  formatDate,
  formatDuration,
  Loading,
  Modal,
  modeLabel,
  Notice,
} from '../components/ui';

const eventNames = {
  mode_changed: '방식 변경',
  paused: '일시정지',
  resumed: '재개',
  calibration_started: '기준 설정',
  calibration_completed: '설정 완료',
  calibration_failed: '설정 실패',
  alert_delivery: '알림',
  correction_observed: '변화 확인',
};

type Timeline = components['schemas']['Timeline'];

function isCurrentMeasurement(sessionId: string, state = useMeasurement.getState()) {
  return (
    state.session?.id === sessionId &&
    ['starting', 'active', 'paused', 'recalibrating', 'ending'].includes(state.phase)
  );
}

async function readTimelinePage(
  sessionId: string,
  from: number,
  signal: AbortSignal,
): Promise<Timeline> {
  const page = await api.timeline(sessionId, from, signal);
  if (signal.aborted) throw new Error('조회가 취소되었습니다.');
  if (page.session_id !== sessionId || page.resolution_ms !== 60000)
    throw new Error('타임라인을 확인해 주세요.');
  let end = from;
  for (const bucket of page.buckets) {
    if (
      bucket.elapsed_start_ms !== end ||
      !Number.isSafeInteger(bucket.duration_ms) ||
      bucket.duration_ms < 1 ||
      bucket.duration_ms > 60000
    )
      throw new Error('타임라인을 확인해 주세요.');
    end += bucket.duration_ms;
  }
  if (
    page.next_from_elapsed_ms !== null &&
    (!Number.isSafeInteger(page.next_from_elapsed_ms) ||
      page.next_from_elapsed_ms !== end ||
      end <= from)
  )
    throw new Error('타임라인을 확인해 주세요.');
  return page;
}

async function readAllTimeline(sessionId: string, signal: AbortSignal): Promise<Timeline> {
  const buckets: Timeline['buckets'] = [];
  let from = 0;
  while (true) {
    if (signal.aborted) throw new Error('내보내기가 취소되었습니다.');
    const page = await readTimelinePage(sessionId, from, signal);
    buckets.push(...page.buckets);
    if (page.next_from_elapsed_ms === null)
      return { session_id: sessionId, resolution_ms: 60000, buckets, next_from_elapsed_ms: null };
    from = page.next_from_elapsed_ms;
  }
}

async function readAllEvents(sessionId: string, signal: AbortSignal): Promise<SessionEvent[]> {
  const result: SessionEvent[] = [];
  const cursors = new Set<string>();
  const identities = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    if (signal.aborted) throw new Error('내보내기가 취소되었습니다.');
    const page = await api.eventList(sessionId, cursor, signal);
    if (signal.aborted) throw new Error('내보내기가 취소되었습니다.');
    for (const event of page.items) {
      if (identities.has(event.event_id)) throw new Error('이벤트가 중복되었습니다.');
      identities.add(event.event_id);
      result.push(event);
    }
    if (page.next_cursor === null) return result;
    if (!page.next_cursor || cursors.has(page.next_cursor))
      throw new Error('페이지를 확인해 주세요.');
    cursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }
}

export function SessionPage() {
  const { sessionId } = useParams({ strict: false }) as { sessionId: string };
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const confirm = confirmFor === sessionId;
  const measuring = useMeasurement((state) => isCurrentMeasurement(sessionId, state));
  const exportRequest = useRef<AbortController | null>(null);
  const [exportState, setExportState] = useState<{
    sessionId: string;
    loading: boolean;
    error: boolean;
  } | null>(null);
  const exporting = exportState?.sessionId === sessionId && exportState.loading;
  const exportFailed = exportState?.sessionId === sessionId && exportState.error;
  useEffect(
    () => () => {
      exportRequest.current?.abort();
      exportRequest.current = null;
    },
    [sessionId],
  );
  const session = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.session(sessionId),
  });
  const timeline = useInfiniteQuery({
    queryKey: ['timeline', sessionId],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => readTimelinePage(sessionId, pageParam, signal),
    getNextPageParam: (last) => last.next_from_elapsed_ms ?? undefined,
    enabled: !!session.data,
  });
  const timelineBuckets = timeline.data?.pages.flatMap((page) => page.buckets) ?? [];
  const events = useInfiniteQuery({
    queryKey: ['events', sessionId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.eventList(sessionId, pageParam),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!session.data,
  });
  const eventItems = events.data?.pages.flatMap((page) => page.items) ?? [];
  const remove = useMutation({
    mutationFn: () => {
      if (isCurrentMeasurement(sessionId)) throw new Error('측정을 종료한 뒤 삭제해 주세요.');
      return api.remove(sessionId);
    },
    onSuccess: async () => {
      await cache.invalidateQueries();
      await navigate({ to: '/history' });
    },
  });
  if (session.isLoading) return <Loading />;
  if (session.isError)
    return <ErrorState error={errorMessage(session.error)} retry={() => void session.refetch()} />;
  if (!session.data) return null;
  const data = session.data;

  async function download() {
    if (exportRequest.current || !timeline.data) return;
    const controller = new AbortController();
    exportRequest.current = controller;
    setExportState({ sessionId, loading: true, error: false });
    try {
      const allTimeline = await readAllTimeline(sessionId, controller.signal);
      const allEvents = await readAllEvents(sessionId, controller.signal);
      if (controller.signal.aborted) return;
      const content = { session: data, timeline: allTimeline, events: allEvents };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }),
      );
      const revoke = URL.revokeObjectURL.bind(URL);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ecolephant-${sessionId}.json`;
      try {
        anchor.click();
      } finally {
        setTimeout(() => revoke(url), 1000);
      }
    } catch {
      if (!controller.signal.aborted) setExportState({ sessionId, loading: false, error: true });
    } finally {
      if (exportRequest.current === controller) exportRequest.current = null;
      if (!controller.signal.aborted)
        setExportState((state) =>
          state?.sessionId === sessionId ? { ...state, loading: false } : state,
        );
    }
  }

  return (
    <div>
      <Link to="/history" className="back-link">
        ← 기록
      </Link>
      <div className="page-heading">
        <h1>{formatDate(data.started_at)}</h1>
        <span className="badge neutral">{data.data_source === 'real' ? '실제' : '테스트'}</span>
      </div>
      {data.status !== 'completed' && <Notice>미완료 세션</Notice>}
      <section className="panel service-panel">
        <h2>요약 · {modeLabel[data.requested_mode]}</h2>
        {data.summaries.length ? (
          data.summaries.map((summary) => (
            <div key={summary.active_mode} className="service-summary">
              <strong>{modeLabel[summary.active_mode]}</strong>
              <span>유효 {formatDuration(summary.metrics.valid_duration_ms)}</span>
              <span>
                정상{' '}
                {summary.metrics.within_range_percent == null
                  ? '—'
                  : `${summary.metrics.within_range_percent.toFixed(1)}%`}
              </span>
              <span>알림 {summary.metrics.first_stage_alert_count}회</span>
            </div>
          ))
        ) : (
          <p className="service-note">기록 없음</p>
        )}
      </section>
      <section className="panel service-panel">
        <h2>타임라인</h2>
        {timeline.isError && !timeline.data ? (
          <ErrorState error={errorMessage(timeline.error)} retry={() => void timeline.refetch()} />
        ) : timeline.isLoading ? (
          <Loading />
        ) : timelineBuckets.length ? (
          <div className="service-table-wrap">
            <table className="service-table">
              <thead>
                <tr>
                  <th>시작</th>
                  <th>정상</th>
                  <th>주의</th>
                  <th>높음</th>
                  <th>판단 불가</th>
                </tr>
              </thead>
              <tbody>
                {timelineBuckets.map((bucket) => (
                  <tr key={bucket.elapsed_start_ms}>
                    <td>{formatDuration(bucket.elapsed_start_ms)}</td>
                    <td>{formatDuration(bucket.normal_ms)}</td>
                    <td>{formatDuration(bucket.caution_ms)}</td>
                    <td>{formatDuration(bucket.high_ms)}</td>
                    <td>{formatDuration(bucket.unknown_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="service-note">기록 없음</p>
        )}
        {timeline.isFetchNextPageError ? (
          <ErrorState
            error={errorMessage(timeline.error)}
            retry={() => void timeline.fetchNextPage()}
          />
        ) : (
          timeline.hasNextPage && (
            <Button
              variant="secondary"
              disabled={timeline.isFetchingNextPage}
              onClick={() => void timeline.fetchNextPage()}
            >
              타임라인 더 보기
            </Button>
          )
        )}
      </section>
      <section className="panel service-panel">
        <h2>이벤트</h2>
        {events.isError && !events.data ? (
          <ErrorState error={errorMessage(events.error)} retry={() => void events.refetch()} />
        ) : events.isLoading ? (
          <Loading />
        ) : eventItems.length ? (
          <div className="service-list">
            {eventItems.map((event) => (
              <div key={event.event_id} className="service-list-row">
                <span>{formatDuration(event.elapsed_ms)}</span>
                <strong>{eventNames[event.type]}</strong>
              </div>
            ))}
          </div>
        ) : (
          <p className="service-note">기록 없음</p>
        )}
        {events.isFetchNextPageError ? (
          <ErrorState
            error={errorMessage(events.error)}
            retry={() => void events.fetchNextPage()}
          />
        ) : (
          events.hasNextPage && (
            <Button
              variant="secondary"
              disabled={events.isFetchingNextPage}
              onClick={() => void events.fetchNextPage()}
            >
              더 보기
            </Button>
          )
        )}
      </section>
      <div className="button-row service-actions">
        {exportFailed && <Notice kind="error">내보내기를 완료하지 못했습니다.</Notice>}
        <Button
          variant="secondary"
          onClick={() => void download()}
          disabled={
            timeline.isLoading ||
            timeline.isError ||
            !timeline.data ||
            exporting ||
            confirm ||
            remove.isPending
          }
        >
          {exporting ? '내보내는 중' : '내보내기'}
        </Button>
        <Button
          variant="danger"
          disabled={exporting || measuring}
          onClick={() => setConfirmFor(sessionId)}
        >
          삭제
        </Button>
        {measuring && (
          <Link to="/measure" className="button button-secondary">
            측정 화면
          </Link>
        )}
      </div>
      {measuring && <Notice>측정을 종료한 뒤 삭제할 수 있습니다.</Notice>}
      <Modal
        open={confirm}
        onOpenChange={(open) => setConfirmFor(open ? sessionId : null)}
        title="기록 삭제"
        description={
          data.status === 'active'
            ? '다른 탭이나 기기에서 측정 중일 수 있습니다. 삭제하면 저장할 수 없습니다.'
            : '이 세션과 결과를 삭제합니다.'
        }
      >
        {remove.isError && <Notice kind="error">{errorMessage(remove.error)}</Notice>}
        {measuring && <Notice>측정을 종료한 뒤 삭제할 수 있습니다.</Notice>}
        <div className="button-row modal-actions">
          <Button variant="secondary" onClick={() => setConfirmFor(null)}>
            취소
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending || measuring}
            onClick={() => remove.mutate()}
          >
            삭제
          </Button>
        </div>
      </Modal>
    </div>
  );
}
