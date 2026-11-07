import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: { session: vi.fn(), timeline: vi.fn(), eventList: vi.fn(), remove: vi.fn() },
  navigate: vi.fn(),
  createSessionPdf: vi.fn(),
}));
vi.mock('../features/pdf/session-report', () => ({ createSessionPdf: mocks.createSessionPdf }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useParams: () => ({ sessionId: 'synthetic-session' }),
  useNavigate: () => mocks.navigate,
}));
vi.mock('../api/client', () => ({
  api: mocks.api,
  errorMessage: () => '내보내기를 완료하지 못했습니다.',
}));
import { SessionPage } from './SessionPage';
import type { Session } from '../api/client';
import { initialMeasurement, useMeasurement } from '../state/measurement';

const first = { event_id: 'event-first', event_seq: 1, elapsed_ms: 0, type: 'paused', data: {} };
const second = { event_id: 'event-second', event_seq: 2, elapsed_ms: 1, type: 'resumed', data: {} };
const firstPage = { items: [first], next_cursor: 'page-2' };
const lastPage = { items: [second], next_cursor: null };
const createUrl = vi.fn((blob: Blob) => {
  void blob;
  return 'blob:synthetic-download';
});
let click: ReturnType<typeof vi.spyOn>;

function setup() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={cache}>
      <SessionPage />
    </QueryClientProvider>,
  );
}

async function downloaded() {
  const blob = createUrl.mock.calls[0][0];
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(JSON.parse(String(reader.result)));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

beforeEach(() => {
  useMeasurement.setState({ ...initialMeasurement }, true);
  mocks.api.remove.mockResolvedValue(undefined);
  mocks.navigate.mockResolvedValue(undefined);
  mocks.createSessionPdf.mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }));
  mocks.api.session.mockResolvedValue({
    id: 'synthetic-session',
    started_at: '2026-10-17T10:00:00Z',
    status: 'completed',
    data_source: 'demo',
    requested_mode: 'webcam',
    summaries: [],
  });
  mocks.api.timeline.mockResolvedValue({
    session_id: 'synthetic-session',
    resolution_ms: 60000,
    buckets: [],
    next_from_elapsed_ms: null,
  });
  mocks.api.eventList.mockImplementation(async (_id, cursor) =>
    cursor === 'page-2' ? lastPage : firstPage,
  );
  const OriginalURL = globalThis.URL;
  class TestURL extends OriginalURL {
    static createObjectURL = createUrl;
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal('URL', TestURL);
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  useMeasurement.setState({ ...initialMeasurement }, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.api.eventList.mockReset();
});

describe('session deletion', () => {
  it.each(['active', 'paused', 'recalibrating', 'ending'] as const)(
    'blocks deleting the current session while it is %s',
    async (phase) => {
      useMeasurement.setState({ phase, session: { id: 'synthetic-session' } as Session });
      setup();
      expect(await screen.findByRole('button', { name: '삭제' })).toBeDisabled();
      expect(screen.getByRole('link', { name: '측정 화면' })).toBeInTheDocument();
      expect(mocks.api.remove).not.toHaveBeenCalled();
    },
  );

  it('allows deleting a different unfinished session', async () => {
    useMeasurement.setState({ phase: 'active', session: { id: 'another-session' } as Session });
    mocks.api.session.mockResolvedValue({
      id: 'synthetic-session',
      started_at: '2026-10-17T10:00:00Z',
      status: 'active',
      data_source: 'demo',
      requested_mode: 'webcam',
      summaries: [],
    });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('다른 탭이나 기기에서 측정 중일 수 있습니다');
    fireEvent.click(within(dialog).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(mocks.api.remove).toHaveBeenCalledWith('synthetic-session'));
  });

  it('blocks the confirmation if the displayed session becomes active', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
    const dialog = await screen.findByRole('dialog');
    act(() => {
      useMeasurement.setState({ phase: 'active', session: { id: 'synthetic-session' } as Session });
    });
    expect(within(dialog).getByRole('button', { name: '삭제' })).toBeDisabled();
    expect(mocks.api.remove).not.toHaveBeenCalled();
  });
});

describe('session export', () => {
  it('shows a nonzero sub-second valid interval instead of zero seconds', async () => {
    mocks.api.session.mockResolvedValue({
      id: 'synthetic-session',
      started_at: '2026-10-17T10:00:00Z',
      status: 'completed',
      data_source: 'demo',
      requested_mode: 'webcam',
      summaries: [
        {
          active_mode: 'webcam',
          metrics: {
            valid_duration_ms: 500,
            normal_duration_ms: 500,
            caution_duration_ms: 0,
            high_duration_ms: 0,
            forward_head_suspected_ms: 0,
            mean_display_angle_deg: 8.25,
            within_range_percent: 100,
            first_stage_alert_count: 0,
            corrected_alert_count: 0,
            unknown_correction_count: 0,
            mean_correction_ms: null,
          },
        },
      ],
    });
    setup();
    expect(await screen.findByText('1초 미만')).toBeInTheDocument();
    expect(screen.getByText('100.0%')).toBeInTheDocument();
    expect(screen.getByText('정상 1초 미만')).toBeInTheDocument();
    expect(screen.getByText('평균 각도(추정)').nextSibling).toHaveTextContent('8.3°');
    // 알림이 없으면 교정 지표를 0으로 채우지 않음
    expect(screen.getByText('알림 후 자세 변화').nextSibling).toHaveTextContent('—');
  });

  it('keeps earlier timeline pages visible after a later page fails and retries the failed page', async () => {
    let fail = true;
    mocks.api.timeline.mockImplementation(async (_id, from) => {
      if (from === 60000 && fail) throw new Error('offline');
      return {
        session_id: 'synthetic-session',
        resolution_ms: 60000,
        buckets: [
          {
            elapsed_start_ms: from,
            duration_ms: 60000,
            normal_ms: 60000,
            caution_ms: 0,
            high_ms: 0,
            unknown_ms: 0,
            active_modes: ['webcam'],
          },
        ],
        next_from_elapsed_ms: from === 0 ? 60000 : null,
      };
    });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '타임라인 더 보기' }));
    await screen.findByRole('alert');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() =>
      expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3),
    );
  });

  it('keeps earlier events visible after a later page fails and retries the failed page', async () => {
    let fail = true;
    mocks.api.eventList.mockImplementation(async (_id, cursor) => {
      if (cursor !== 'page-2') return firstPage;
      if (fail) throw new Error('offline');
      return lastPage;
    });
    setup();
    await screen.findByText('일시정지');
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    await screen.findByRole('alert');
    expect(screen.getByText('일시정지')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await screen.findByText('재개');
  });

  it('loads another timeline page only when requested', async () => {
    mocks.api.timeline.mockImplementation(async (_id, from) => ({
      session_id: 'synthetic-session',
      resolution_ms: 60000,
      buckets: [
        {
          elapsed_start_ms: from,
          duration_ms: 60000,
          normal_ms: 60000,
          caution_ms: 0,
          high_ms: 0,
          unknown_ms: 0,
          active_modes: ['webcam'],
        },
      ],
      next_from_elapsed_ms: from === 0 ? 60000 : null,
    }));
    setup();
    const button = await screen.findByRole('button', { name: '타임라인 더 보기' });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    fireEvent.click(button);
    await waitFor(() =>
      expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3),
    );
    expect(screen.queryByRole('button', { name: '타임라인 더 보기' })).not.toBeInTheDocument();
  });

  it('downloads a PDF built from every timeline and event page', async () => {
    const bucket = {
      elapsed_start_ms: 0,
      duration_ms: 60000,
      normal_ms: 60000,
      caution_ms: 0,
      high_ms: 0,
      unknown_ms: 0,
      active_modes: ['webcam'],
    };
    mocks.api.timeline.mockImplementation(async (_id, from) => ({
      session_id: 'synthetic-session',
      resolution_ms: 60000,
      buckets: [{ ...bucket, elapsed_start_ms: from }],
      next_from_elapsed_ms: from === 0 ? 60000 : null,
    }));
    setup();
    await screen.findByText('일시정지');
    fireEvent.click(screen.getByRole('button', { name: 'PDF로 저장' }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    const input = mocks.createSessionPdf.mock.calls[0][0];
    expect(input.buckets.map((b: { elapsed_start_ms: number }) => b.elapsed_start_ms)).toEqual([
      0, 60000,
    ]);
    expect(input.events.map((e: { event_id: string }) => e.event_id)).toEqual([
      'event-first',
      'event-second',
    ]);
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('ecolephant-synthetic-session.pdf');
    expect(createUrl.mock.calls[0][0].type).toBe('application/pdf');
  });

  it('shows an error when the PDF cannot be created', async () => {
    mocks.createSessionPdf.mockRejectedValueOnce(new Error('canvas'));
    setup();
    await screen.findByText('일시정지');
    fireEvent.click(screen.getByRole('button', { name: 'PDF로 저장' }));
    expect(await screen.findByText(/PDF를 준비하지 못했습니다/)).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
  });

  it('exports all timeline pages without requiring manual pagination', async () => {
    const firstBucket = {
      elapsed_start_ms: 0,
      duration_ms: 60000,
      normal_ms: 60000,
      caution_ms: 0,
      high_ms: 0,
      unknown_ms: 0,
      active_modes: ['webcam'],
    };
    const secondBucket = { ...firstBucket, elapsed_start_ms: 60000 };
    mocks.api.timeline.mockImplementation(async (_id, from) => ({
      session_id: 'synthetic-session',
      resolution_ms: 60000,
      buckets: [from === 60000 ? secondBucket : firstBucket],
      next_from_elapsed_ms: from === 60000 ? null : 60000,
    }));
    setup();
    await screen.findByText('일시정지');
    fireEvent.click(screen.getByRole('button', { name: '내보내기' }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    const content = await downloaded();
    expect((content.timeline as { buckets: unknown[] }).buckets).toEqual([
      firstBucket,
      secondBucket,
    ]);
    expect(mocks.api.timeline.mock.calls.some((call) => call[1] === 60000)).toBe(true);
  });

  it('does not download when a later timeline page fails', async () => {
    mocks.api.timeline.mockImplementation(async (_id, from) => {
      if (from === 60000) throw new Error('synthetic timeline error');
      return {
        session_id: 'synthetic-session',
        resolution_ms: 60000,
        buckets: [
          {
            elapsed_start_ms: 0,
            duration_ms: 60000,
            normal_ms: 60000,
            caution_ms: 0,
            high_ms: 0,
            unknown_ms: 0,
            active_modes: ['webcam'],
          },
        ],
        next_from_elapsed_ms: 60000,
      };
    });
    setup();
    await screen.findByText('일시정지');
    fireEvent.click(screen.getByRole('button', { name: '내보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('내보내기');
    expect(createUrl).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('cancels a pending timeline export when leaving the page', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.api.timeline.mockImplementation(async (_id, from) => {
      if (from === 60000)
        return await new Promise((resolve) => {
          finish = resolve;
        });
      return {
        session_id: 'synthetic-session',
        resolution_ms: 60000,
        buckets: [
          {
            elapsed_start_ms: 0,
            duration_ms: 60000,
            normal_ms: 60000,
            caution_ms: 0,
            high_ms: 0,
            unknown_ms: 0,
            active_modes: ['webcam'],
          },
        ],
        next_from_elapsed_ms: 60000,
      };
    });
    const view = setup();
    await screen.findByRole('button', { name: '타임라인 더 보기' });
    fireEvent.click(screen.getByRole('button', { name: '내보내기' }));
    await waitFor(() =>
      expect(mocks.api.timeline.mock.calls.some((call) => call[1] === 60000)).toBe(true),
    );
    const signal = mocks.api.timeline.mock.calls.find(
      (call) => call[1] === 60000,
    )?.[2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
    finish({
      session_id: 'synthetic-session',
      resolution_ms: 60000,
      buckets: [],
      next_from_elapsed_ms: null,
    });
    await Promise.resolve();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('rejects a non-advancing timeline page without downloading', async () => {
    mocks.api.timeline.mockImplementation(async (_id, from) => ({
      session_id: 'synthetic-session',
      resolution_ms: 60000,
      buckets: [
        {
          elapsed_start_ms: from,
          duration_ms: 60000,
          normal_ms: 60000,
          caution_ms: 0,
          high_ms: 0,
          unknown_ms: 0,
          active_modes: ['webcam'],
        },
      ],
      next_from_elapsed_ms: 60000,
    }));
    setup();
    await screen.findByRole('button', { name: '타임라인 더 보기' });
    fireEvent.click(screen.getByRole('button', { name: '내보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('내보내기');
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('exports every event page without requiring manual pagination', async () => {
    setup();
    await screen.findByText('일시정지');
    const button = screen.getByRole('button', { name: '내보내기' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect((await downloaded()).events).toEqual([first, second]);
    expect(mocks.api.eventList.mock.calls.some((call) => call[1] === 'page-2')).toBe(true);
  });

  it('does not download a partial file when a later page fails', async () => {
    mocks.api.eventList.mockImplementation(async (_id, cursor) => {
      if (cursor === 'page-2') throw new Error('synthetic network error');
      return firstPage;
    });
    setup();
    await screen.findByText('일시정지');
    fireEvent.click(screen.getByRole('button', { name: '내보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('내보내기');
    expect(createUrl).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('does not download after leaving the page during export', async () => {
    let finish: (value: typeof lastPage) => void = () => undefined;
    mocks.api.eventList.mockImplementation(async (_id, cursor) =>
      cursor === 'page-2'
        ? await new Promise<typeof lastPage>((resolve) => {
            finish = resolve;
          })
        : firstPage,
    );
    const view = setup();
    await screen.findByText('일시정지');
    fireEvent.click(screen.getByRole('button', { name: '내보내기' }));
    await waitFor(() =>
      expect(mocks.api.eventList.mock.calls.some((call) => call[1] === 'page-2')).toBe(true),
    );
    const signal = mocks.api.eventList.mock.calls.find(
      (call) => call[1] === 'page-2',
    )?.[2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
    finish(lastPage);
    await Promise.resolve();
    await Promise.resolve();
    expect(createUrl).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('rejects a repeating page cursor without downloading', async () => {
    mocks.api.eventList.mockImplementation(async (_id, cursor) =>
      cursor === 'page-2' ? { items: [second], next_cursor: 'page-2' } : firstPage,
    );
    setup();
    await screen.findByText('일시정지');
    fireEvent.click(screen.getByRole('button', { name: '내보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('내보내기');
    expect(createUrl).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('rejects duplicate events across pages instead of exporting a misleading file', async () => {
    mocks.api.eventList.mockImplementation(async (_id, cursor) =>
      cursor === 'page-2' ? { items: [first], next_cursor: null } : firstPage,
    );
    setup();
    await screen.findByText('일시정지');
    fireEvent.click(screen.getByRole('button', { name: '내보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('내보내기');
    expect(createUrl).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
});
