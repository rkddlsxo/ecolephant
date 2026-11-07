import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Bell,
  CheckCircle2,
  ChevronLeft,
  Crosshair,
  Download,
  FileText,
  Pause,
  Play,
  Repeat,
  Trash2,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { api, errorMessage } from '../api/client';
import type { SessionEvent } from '../api/client';
import type { components } from '../api/generated';
import { useMeasurement } from '../state/measurement';
import { bucketModes, sessionLength, statusLabel, summaryTitle } from '../features/history/format';
import { SessionSummary } from '../features/history/SessionSummary';
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

const eventIcons: Record<keyof typeof eventNames, LucideIcon> = {
  mode_changed: Repeat,
  paused: Pause,
  resumed: Play,
  calibration_started: Crosshair,
  calibration_completed: CheckCircle2,
  calibration_failed: XCircle,
  alert_delivery: Bell,
  correction_observed: TrendingUp,
};

type Timeline = components['schemas']['Timeline'];

function TimelineBar({ bucket }: { bucket: Timeline['buckets'][number] }) {
  const parts = [
    ['normal', bucket.normal_ms],
    ['caution', bucket.caution_ms],
    ['high', bucket.high_ms],
    ['unknown', bucket.unknown_ms],
  ] as const;
  const total = parts.reduce((sum, [, ms]) => sum + ms, 0);
  return (
    <div className="session-bar" aria-hidden="true">
      {total > 0 &&
        parts.map(([key, ms]) =>
          ms > 0 ? (
            <span key={key} className={`is-${key}`} style={{ width: `${(ms / total) * 100}%` }} />
          ) : null,
        )}
    </div>
  );
}

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
  const [pdfState, setPdfState] = useState<'idle' | 'loading' | 'error'>('idle');
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

  // 전체 타임라인·이벤트를 불러와 PDF 파일을 만들어 바로 다운로드함
  async function savePdf() {
    if (pdfState === 'loading' || exportRequest.current) return;
    const controller = new AbortController();
    exportRequest.current = controller;
    setPdfState('loading');
    try {
      const allTimeline = await readAllTimeline(sessionId, controller.signal);
      const allEvents = await readAllEvents(sessionId, controller.signal);
      const { createSessionPdf } = await import('../features/pdf/session-report');
      const blob = await createSessionPdf({
        session: data,
        buckets: allTimeline.buckets,
        events: allEvents,
        eventNames,
      });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const revoke = URL.revokeObjectURL.bind(URL);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ecolephant-${sessionId}.pdf`;
      try {
        anchor.click();
      } finally {
        setTimeout(() => revoke(url), 1000);
      }
      setPdfState('idle');
    } catch {
      if (!controller.signal.aborted) setPdfState('error');
    } finally {
      if (exportRequest.current === controller) exportRequest.current = null;
    }
  }

  return (
    <div className="session-page">
      <Link to="/history" className="back-link">
        <ChevronLeft size={16} aria-hidden="true" />
        세션 기록
      </Link>
      <div className="page-heading">
        <div>
          <div className="title-with-status">
            <h1>{formatDate(data.started_at)}</h1>
            <span className={`history-chip ${data.status === 'completed' ? 'is-done' : 'is-open'}`}>
              {statusLabel(data.status)}
            </span>
            <span className={`history-chip ${data.data_source === 'real' ? 'is-real' : 'is-test'}`}>
              {data.data_source === 'real' ? '실제' : '테스트'}
            </span>
          </div>
          <p className="page-description">
            {modeLabel[data.requested_mode]} 방식으로 측정한 세션이에요. · 측정 길이{' '}
            {sessionLength(data)}
          </p>
        </div>
        <div className="button-row">
          <Button
            variant="secondary"
            className="session-action"
            onClick={() => void download()}
            disabled={
              timeline.isLoading ||
              timeline.isError ||
              !timeline.data ||
              exporting ||
              pdfState === 'loading' ||
              confirm ||
              remove.isPending
            }
          >
            <Download size={16} aria-hidden="true" />
            {exporting ? '내보내는 중' : '내보내기'}
          </Button>
          <Button
            variant="secondary"
            className="session-action"
            onClick={() => void savePdf()}
            disabled={
              timeline.isLoading ||
              timeline.isError ||
              exporting ||
              pdfState === 'loading' ||
              confirm ||
              remove.isPending
            }
          >
            <FileText size={16} aria-hidden="true" />
            {pdfState === 'loading' ? 'PDF 준비 중' : 'PDF로 저장'}
          </Button>
          <Button
            variant="danger"
            className="session-action"
            disabled={exporting || pdfState === 'loading' || measuring}
            onClick={() => setConfirmFor(sessionId)}
          >
            <Trash2 size={16} aria-hidden="true" />
            삭제
          </Button>
          {measuring && (
            <Link to="/measure" className="button button-secondary">
              측정 화면
            </Link>
          )}
        </div>
      </div>
      {exportFailed && <Notice kind="error">내보내기를 완료하지 못했습니다.</Notice>}
      {pdfState === 'error' && (
        <Notice kind="error">PDF를 준비하지 못했습니다. 다시 시도해 주세요.</Notice>
      )}
      {measuring && <Notice>측정을 종료한 뒤 삭제할 수 있습니다.</Notice>}
      <section className="panel service-panel">
        <h2 className="history-section-title">요약</h2>
        {data.summaries.length ? (
          <div className="session-summaries">
            {data.summaries.map((summary) => (
              <SessionSummary
                key={summary.active_mode}
                mode={summary.active_mode}
                metrics={summary.metrics}
                title={summaryTitle(data.requested_mode, summary.active_mode)}
              />
            ))}
          </div>
        ) : (
          <p className="service-note">기록 없음</p>
        )}
        {data.unassigned_unknown_duration_ms > 0 && (
          <p className="service-note">
            미분류 시간 {formatDuration(data.unassigned_unknown_duration_ms)}
          </p>
        )}
      </section>
      <section className="panel service-panel">
        <div className="session-section-head">
          <h2 className="history-section-title">타임라인</h2>
          <ul className="session-legend" aria-hidden="true">
            <li className="is-normal">정상</li>
            <li className="is-caution">주의</li>
            <li className="is-high">높음</li>
            <li className="is-unknown">판단 불가</li>
          </ul>
        </div>
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
                  <th>방식</th>
                  <th className="session-bar-cell">분포</th>
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
                    <td>{bucketModes(bucket.active_modes)}</td>
                    <td className="session-bar-cell">
                      <TimelineBar bucket={bucket} />
                    </td>
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
        <h2 className="history-section-title">이벤트</h2>
        {events.isError && !events.data ? (
          <ErrorState error={errorMessage(events.error)} retry={() => void events.refetch()} />
        ) : events.isLoading ? (
          <Loading />
        ) : eventItems.length ? (
          <ol className="session-events">
            {eventItems.map((event) => {
              const Icon = eventIcons[event.type];
              return (
                <li key={event.event_id} className={`session-event is-${event.type}`}>
                  <span className="session-event-icon" aria-hidden="true">
                    <Icon size={14} />
                  </span>
                  <strong>{eventNames[event.type]}</strong>
                  <span className="session-event-time">{formatDuration(event.elapsed_ms)}</span>
                </li>
              );
            })}
          </ol>
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
