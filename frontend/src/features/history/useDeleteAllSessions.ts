import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, isMissingSession } from '../../api/client';
import type { Session } from '../../api/client';
import { useMeasurement } from '../../state/measurement';

const RUNNING = ['starting', 'active', 'paused', 'recalibrating', 'ending'];

export type DeleteAllState =
  | { status: 'idle' }
  | { status: 'counting' }
  | { status: 'ready'; targets: Session[]; activeCount: number; skippedCurrent: boolean }
  | { status: 'deleting'; done: number; total: number }
  | { status: 'done'; deleted: number }
  | { status: 'error'; message: string; deleted: number; total: number };

/** 이 탭에서 지금 측정 중인 세션 ID. 이 세션은 전체 삭제에서 뺌 */
function currentMeasurementId() {
  const state = useMeasurement.getState();
  return state.session && RUNNING.includes(state.phase) ? state.session.id : null;
}

/** 기간·방식과 상관없이 내 모든 세션을 모음 (서버 목록은 기간 없이 부르면 전체) */
async function listAllSessions() {
  const all: Session[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await api.sessions({ limit: 100, cursor, order: 'desc' });
    all.push(...page.items);
    cursor = page.next_cursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error('세션 목록을 확인해 주세요.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return all;
}

/**
 * 세션 전체 삭제. 서버에 한꺼번에 지우는 API가 없어 한 건씩 지움.
 * 1) prepare: 대상 개수를 세어 확인 창에 보여 주고 2) run: 확인 후 차례로 삭제.
 * 중간에 실패하면 멈추고 몇 건까지 지웠는지 알려 줌. 이미 지워진 세션은 성공으로 셈.
 */
export function useDeleteAllSessions() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<DeleteAllState>({ status: 'idle' });

  const prepare = async () => {
    setState({ status: 'counting' });
    try {
      const current = currentMeasurementId();
      const all = await listAllSessions();
      const targets = all.filter((session) => session.id !== current);
      setState({
        status: 'ready',
        targets,
        activeCount: targets.filter((session) => session.status === 'active').length,
        skippedCurrent: targets.length !== all.length,
      });
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error), deleted: 0, total: 0 });
    }
  };

  const run = async () => {
    if (state.status !== 'ready') return;
    const current = currentMeasurementId();
    const targets = state.targets.filter((session) => session.id !== current);
    let deleted = 0;
    setState({ status: 'deleting', done: 0, total: targets.length });
    try {
      for (const session of targets) {
        try {
          await api.remove(session.id);
        } catch (error) {
          if (!isMissingSession(error)) throw error;
        }
        deleted += 1;
        setState({ status: 'deleting', done: deleted, total: targets.length });
      }
      setState({ status: 'done', deleted });
    } catch (error) {
      setState({
        status: 'error',
        message: errorMessage(error),
        deleted,
        total: targets.length,
      });
    } finally {
      await queryClient.invalidateQueries().catch(() => undefined);
    }
  };

  return { state, prepare, run, reset: () => setState({ status: 'idle' }) };
}
