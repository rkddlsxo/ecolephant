import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Download, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../api/client';
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
  mode_changed: '측정 방식 변경',
  paused: '일시정지',
  resumed: '재개',
  calibration_started: '기준 재설정 시작',
  calibration_completed: '기준 재설정 완료',
  calibration_failed: '기준 재설정 실패',
  alert_delivery: '알림 전달',
  correction_observed: '교정 관찰',
};
export function SessionPage() {
  const { sessionId } = useParams({ strict: false }) as { sessionId: string };
  const navigate = useNavigate(),
    cache = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const session = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.session(sessionId),
  });
  const timeline = useQuery({
    queryKey: ['timeline', sessionId],
    queryFn: () => api.timeline(sessionId),
    enabled: !!session.data,
  });
  const events = useInfiniteQuery({
    queryKey: ['events', sessionId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.eventList(sessionId, pageParam),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!session.data,
  });
  const eventItems = events.data?.pages.flatMap((page) => page.items) ?? [];
  const remove = useMutation({
    mutationFn: () => api.remove(sessionId),
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
  function download() {
    const content = {
      session: data,
      timeline: timeline.data,
      events: { items: eventItems, next_cursor: events.data?.pages.at(-1)?.next_cursor ?? null },
      data_source: 'demo',
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ecolephant-${sessionId}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div>
      <Link to="/history" className="back-link">
        <ArrowLeft size={16} />
        기록으로 돌아가기
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">한 번의 측정, 하나의 기록</span>
          <h1>{formatDate(data.started_at)}</h1>
          <p>
            {modeLabel[data.requested_mode]} ·{' '}
            {data.ended_at
              ? formatDuration(Date.parse(data.ended_at) - Date.parse(data.started_at))
              : '미완료 세션'}
          </p>
        </div>
        <span className="badge neutral">가상 입력 기록</span>
      </div>
      {data.status !== 'completed' && (
        <Notice>
          아직 종료 승인되지 않은 기록입니다. 미전송 결과는 원래 측정 창에만 남아 있을 수 있어요.
        </Notice>
      )}
      <section className="panel">
        <div className="section-heading">
          <h2>방식별 요약</h2>
          <span className="badge outline">{data.policy_id}</span>
        </div>
        {data.summaries.length ? (
          data.summaries.map((s) => (
            <div key={s.active_mode} className="summary-group">
              <h3>{modeLabel[s.active_mode]}</h3>
              <div className="summary-grid">
                <div>
                  <span>유효 시간</span>
                  <strong>{formatDuration(s.metrics.valid_duration_ms)}</strong>
                </div>
                <div>
                  <span>기준 범위 비율</span>
                  <strong>
                    {s.metrics.within_range_percent == null
                      ? '—'
                      : `${s.metrics.within_range_percent.toFixed(1)}%`}
                  </strong>
                </div>
                <div>
                  <span>평균 참고 각도</span>
                  <strong>
                    {s.metrics.mean_display_angle_deg == null
                      ? '—'
                      : `${s.metrics.mean_display_angle_deg.toFixed(1)}°`}
                  </strong>
                </div>
                <div>
                  <span>높은 신호 시간</span>
                  <strong>{formatDuration(s.metrics.high_duration_ms)}</strong>
                </div>
                <div>
                  <span>전달된 1차 알림</span>
                  <strong>{s.metrics.first_stage_alert_count}회</strong>
                </div>
                <div>
                  <span>평균 교정 소요</span>
                  <strong>
                    {s.metrics.mean_correction_ms == null
                      ? '—'
                      : formatDuration(s.metrics.mean_correction_ms)}
                  </strong>
                  <small>
                    확인 {s.metrics.corrected_alert_count}건 · 미확인{' '}
                    {s.metrics.unknown_correction_count}건
                  </small>
                </div>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">아직 저장된 창이 없습니다.</p>
        )}
        <p className="muted">
          방식 미지정 판단 불가: {formatDuration(data.unassigned_unknown_duration_ms)}
        </p>
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>1분 단위 타임라인</h2>
            <p>판단 불가를 포함한 시간 구성입니다.</p>
          </div>
        </div>
        {timeline.isError ? (
          <ErrorState error={errorMessage(timeline.error)} retry={() => void timeline.refetch()} />
        ) : timeline.isLoading ? (
          <Loading />
        ) : timeline.data?.buckets.length ? (
          <div className="timeline-rows">
            {timeline.data.buckets.map((b) => (
              <div className="bar-row" key={b.elapsed_start_ms}>
                <span>{formatDuration(b.elapsed_start_ms)}</span>
                <div className="stacked-bar">
                  {(['normal', 'caution', 'high', 'unknown'] as const).map((level) => (
                    <i
                      key={level}
                      className={level}
                      style={{ width: `${(b[`${level}_ms`] / b.duration_ms) * 100}%` }}
                      title={`${level}: ${formatDuration(b[`${level}_ms`])}`}
                    />
                  ))}
                </div>
                <small>{formatDuration(b.duration_ms)}</small>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">타임라인이 없습니다.</p>
        )}
        <div className="legend">
          <span className="legend-normal">기준 범위</span>
          <span className="legend-caution">주의</span>
          <span className="legend-high">높음</span>
          <span className="legend-unknown">판단 불가</span>
        </div>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>상태·알림 이벤트</h2>
          <span className="badge neutral">{eventItems.length}개 불러옴</span>
        </div>
        {events.isError ? (
          <ErrorState error={errorMessage(events.error)} retry={() => void events.refetch()} />
        ) : eventItems.length ? (
          <div className="event-list">
            {eventItems.map((e) => (
              <div key={e.event_id}>
                <time>{formatDuration(e.elapsed_ms)}</time>
                <strong>{eventNames[e.type]}</strong>
                <span>
                  {e.type === 'alert_delivery'
                    ? `${e.data.stage}차 · ${e.data.result}`
                    : e.type === 'correction_observed'
                      ? e.data.outcome === 'corrected'
                        ? '변화 확인'
                        : '확인하지 못함'
                      : e.type === 'mode_changed'
                        ? `${modeLabel[e.data.previous_mode]} → ${modeLabel[e.data.current_mode]}`
                        : ''}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">기록된 이벤트가 없습니다.</p>
        )}
        {events.hasNextPage && (
          <Button
            variant="secondary"
            disabled={events.isFetchingNextPage}
            onClick={() => void events.fetchNextPage()}
          >
            이벤트 더 보기
          </Button>
        )}
      </section>
      <div className="measurement-footer">
        <span className="muted">데모 정책 · 실측 검증 전</span>
        <div className="button-row">
          <Button
            variant="secondary"
            onClick={download}
            disabled={
              timeline.isLoading ||
              events.isLoading ||
              timeline.isError ||
              events.isError ||
              events.hasNextPage
            }
          >
            <Download size={16} />
            JSON 내보내기
          </Button>
          <Button variant="danger" onClick={() => setConfirm(true)}>
            <Trash2 size={16} />
            기록 삭제
          </Button>
        </div>
      </div>
      <Modal
        open={confirm}
        onOpenChange={setConfirm}
        title="이 기록을 삭제할까요?"
        description="세션과 연결된 파생 결과·이벤트를 삭제합니다. 삭제한 기록은 복구할 수 없습니다."
      >
        {remove.isError && <Notice kind="error">{errorMessage(remove.error)}</Notice>}
        <div className="button-row modal-actions">
          <Button variant="secondary" onClick={() => setConfirm(false)}>
            취소
          </Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? '삭제 중…' : '삭제하기'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
