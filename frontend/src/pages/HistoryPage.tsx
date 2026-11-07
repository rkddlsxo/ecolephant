import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Mode } from '@ecolephant/ai';
import { BarChart3, Inbox, ListChecks, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import type { Statistics } from '../api/client';
import { Select } from '../components/Select';
import { StatisticsTables } from '../features/history/StatisticsTables';
import { useSeoulDayEnd } from '../features/history/useSeoulDayEnd';
import { SessionRows } from '../features/history/SessionRows';
import { useDeleteAllSessions } from '../features/history/useDeleteAllSessions';
import { Button, ErrorState, Loading, Modal, modeLabel, Notice } from '../components/ui';

const dayOptions = [
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
const orderOptions = [
  { value: 'desc', label: '최신순' },
  { value: 'asc', label: '오래된순' },
] as const;
type Order = (typeof orderOptions)[number]['value'];
const unitOptions = [
  { value: 'day', label: '일별' },
  { value: 'hour', label: '시간별' },
] as const;

export function HistoryPage() {
  const [days, setDays] = useState(7);
  const [mode, setMode] = useState<Mode | ''>('');
  const [unit, setUnit] = useState<Statistics['group_by']>('day');
  const [order, setOrder] = useState<Order>('desc');
  const deleteAll = useDeleteAllSessions();
  const deleting = deleteAll.state.status === 'deleting';
  const dialogOpen = deleteAll.state.status !== 'idle';
  const dayEnd = useSeoulDayEnd();
  const range = useMemo(
    () => ({
      from: new Date(dayEnd - days * 86400000).toISOString(),
      to: new Date(dayEnd).toISOString(),
    }),
    [dayEnd, days],
  );
  const sessions = useInfiniteQuery({
    queryKey: ['sessions', range, mode, order],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.sessions({
        ...range,
        mode: mode || undefined,
        limit: 20,
        cursor: pageParam,
        order,
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
        // 통계·추이의 기본값(세션 상태 '전체')과 같게, 진행 중인 측정도 바로 보이게 함
        include_active: 'true',
        ...(mode ? { mode } : {}),
      }),
  });
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  const groups = stats.data?.groups ?? [];
  return (
    <div className="history-page">
      <div className="page-heading">
        <div>
          <h1>세션 기록</h1>
          <p className="page-description">
            지난 측정 세션과 기간별 통계를 확인해요. 세션을 누르면 자세한 결과를 볼 수 있어요.
          </p>
        </div>
      </div>
      <div className="service-controls service-filters">
        <Select
          label="기간"
          value={String(days) as '1' | '7' | '30'}
          options={dayOptions}
          onChange={(value) => setDays(Number(value))}
        />
        <Select<Mode | ''> label="방식" value={mode} options={modeOptions} onChange={setMode} />
        <Select<Statistics['group_by']>
          label="단위"
          value={unit}
          options={unitOptions}
          onChange={setUnit}
        />
      </div>
      <section className="panel service-panel">
        <h2 className="history-section-title">
          <BarChart3 size={18} aria-hidden="true" />
          통계
        </h2>
        {stats.isLoading ? (
          <Loading />
        ) : stats.isError ? (
          <ErrorState error={errorMessage(stats.error)} retry={() => void stats.refetch()} />
        ) : (
          <StatisticsTables
            groups={groups}
            unit={unit}
            unassigned={mode ? 0 : (stats.data?.unassigned_unknown_duration_ms ?? 0)}
            range={range}
          />
        )}
      </section>
      <section className="panel service-panel">
        <div className="session-section-head history-sessions-head">
          <h2 className="history-section-title">
            <ListChecks size={18} aria-hidden="true" />
            세션
          </h2>
          <div className="history-sessions-actions">
            <Select<Order> label="정렬" value={order} options={orderOptions} onChange={setOrder} />
            <Button variant="danger" disabled={dialogOpen} onClick={() => void deleteAll.prepare()}>
              <Trash2 size={16} aria-hidden="true" />
              전체 삭제
            </Button>
          </div>
        </div>
        {sessions.isLoading ? (
          <Loading />
        ) : sessions.isError && !sessions.data ? (
          <ErrorState error={errorMessage(sessions.error)} retry={() => void sessions.refetch()} />
        ) : items.length ? (
          <SessionRows items={items} />
        ) : (
          <div className="history-empty">
            <Inbox size={28} aria-hidden="true" />
            <p>이 기간에는 기록이 없어요.</p>
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
      <Modal
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open && !deleting) deleteAll.reset();
        }}
        title="세션 전체 삭제"
        description={deleteDescription(deleteAll.state)}
      >
        {deleteAll.state.status === 'ready' && deleteAll.state.activeCount > 0 && (
          <Notice kind="error">
            진행 중으로 남은 세션 {deleteAll.state.activeCount}개도 함께 지워져요. 다른 탭이나
            기기에서 측정 중이라면 그 측정은 저장되지 않아요.
          </Notice>
        )}
        {deleteAll.state.status === 'error' && (
          <Notice kind="error">{deleteAll.state.message}</Notice>
        )}
        <div className="button-row modal-actions">
          {deleteAll.state.status === 'ready' && deleteAll.state.targets.length > 0 ? (
            <>
              <Button variant="secondary" onClick={deleteAll.reset}>
                취소
              </Button>
              <Button variant="danger" onClick={() => void deleteAll.run()}>
                {deleteAll.state.targets.length}개 모두 삭제
              </Button>
            </>
          ) : (
            <Button variant="secondary" disabled={deleting} onClick={deleteAll.reset}>
              {deleting ? '삭제 중' : '닫기'}
            </Button>
          )}
        </div>
      </Modal>
    </div>
  );
}

function deleteDescription(state: ReturnType<typeof useDeleteAllSessions>['state']) {
  switch (state.status) {
    case 'counting':
      return '삭제할 세션을 확인하고 있어요.';
    case 'ready':
      if (!state.targets.length)
        return state.skippedCurrent
          ? '지금 측정 중인 세션 말고는 지울 세션이 없어요.'
          : '지울 세션이 없어요.';
      return `기간과 상관없이 내 세션 ${state.targets.length}개와 그 측정 결과를 모두 지워요. 되돌릴 수 없어요.${
        state.skippedCurrent ? ' 지금 측정 중인 세션은 빼고 지워요.' : ''
      }`;
    case 'deleting':
      return `삭제 중이에요 (${state.done}/${state.total}). 창을 닫지 말아 주세요.`;
    case 'done':
      return `세션 ${state.deleted}개를 삭제했어요.`;
    case 'error':
      return state.total
        ? `${state.total}개 중 ${state.deleted}개를 지운 뒤 멈췄어요. 닫고 다시 '전체 삭제'를 누르면 남은 세션을 지워요.`
        : '삭제할 세션을 확인하지 못했어요.';
    default:
      return '';
  }
}
