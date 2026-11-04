import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ api: { sessions: vi.fn(), statistics: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: ReactNode; params: { sessionId: string } }) => (
    <a href="#" data-testid={`session-${params.sessionId}`}>
      {children}
    </a>
  ),
}));
vi.mock('../api/client', () => ({ api: mocks.api, errorMessage: () => '조회에 실패했습니다.' }));
import { HistoryPage } from './HistoryPage';

const item = (id: string, started_at: string) => ({
  id,
  started_at,
  requested_mode: 'webcam',
  status: 'completed',
  data_source: 'demo',
});
const newest = item('newest', '2026-11-01T08:00:00Z');
const oldest = item('oldest', '2026-10-31T08:00:00Z');

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HistoryPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.api.sessions.mockResolvedValue({ items: [], next_cursor: null });
  mocks.api.statistics.mockResolvedValue({ groups: [], unassigned_unknown_duration_ms: 0 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('history pagination', () => {
  it('requests the newest sessions first and keeps the order on later pages', async () => {
    mocks.api.sessions.mockImplementation(async (params) => {
      if (params.order !== 'desc') return { items: [oldest], next_cursor: null };
      return params.cursor === 'next'
        ? { items: [oldest], next_cursor: null }
        : { items: [newest], next_cursor: 'next' };
    });
    setup();
    expect(await screen.findByTestId('session-newest')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    await screen.findByTestId('session-oldest');
    expect(screen.getAllByTestId(/^session-/).map((node) => node.dataset.testid)).toEqual([
      'session-newest',
      'session-oldest',
    ]);
    expect(mocks.api.sessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ order: 'desc', cursor: 'next' }),
    );
  });

  it('keeps earlier pages visible when loading another page fails and allows retry', async () => {
    let fail = true;
    mocks.api.sessions.mockImplementation(async (params) => {
      if (!params.cursor) return { items: [newest], next_cursor: 'next' };
      if (fail) throw new Error('offline');
      return { items: [oldest], next_cursor: null };
    });
    setup();
    await screen.findByTestId('session-newest');
    fireEvent.click(screen.getByRole('button', { name: '더 보기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('조회에 실패했습니다.');
    expect(screen.getByTestId('session-newest')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(screen.getByTestId('session-oldest')).toBeInTheDocument());
  });
});

describe('history statistics', () => {
  it.each([
    ['1', '2026-10-31T15:00:00.000Z'],
    ['7', '2026-10-25T15:00:00.000Z'],
    ['30', '2026-10-02T15:00:00.000Z'],
  ])('uses the same Seoul calendar boundaries for %s days in both requests', async (days, from) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T14:00:00Z'));
    setup();
    fireEvent.change(screen.getByLabelText('기간'), { target: { value: days } });
    const range = { from, to: '2026-11-01T15:00:00.000Z' };
    await waitFor(() =>
      expect(mocks.api.statistics).toHaveBeenLastCalledWith(expect.objectContaining(range)),
    );
    expect(mocks.api.sessions).toHaveBeenLastCalledWith(expect.objectContaining(range));
  });

  it('refreshes the requested day after returning to the page across Seoul midnight', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T14:00:00Z'));
    setup();
    fireEvent.change(screen.getByLabelText('기간'), { target: { value: '1' } });
    await waitFor(() =>
      expect(mocks.api.statistics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          from: '2026-10-31T15:00:00.000Z',
          to: '2026-11-01T15:00:00.000Z',
        }),
      ),
    );
    clock.mockReturnValue(Date.parse('2026-11-01T15:00:01Z'));
    fireEvent.focus(window);
    await waitFor(() =>
      expect(mocks.api.statistics).toHaveBeenLastCalledWith(
        expect.objectContaining({
          from: '2026-11-01T15:00:00.000Z',
          to: '2026-11-02T15:00:00.000Z',
        }),
      ),
    );
    expect(mocks.api.sessions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from: '2026-11-01T15:00:00.000Z',
        to: '2026-11-02T15:00:00.000Z',
      }),
    );
  });

  it('shows separate groups and day/hour buckets without inventing zero-denominator ratios', async () => {
    const valid = {
      valid_duration_ms: 60000,
      normal_duration_ms: 30000,
      caution_duration_ms: 0,
      high_duration_ms: 30000,
      within_range_percent: 50,
      first_stage_alert_count: 1,
    };
    const empty = {
      valid_duration_ms: 0,
      normal_duration_ms: 0,
      caution_duration_ms: 0,
      high_duration_ms: 0,
      within_range_percent: 0,
      first_stage_alert_count: 0,
    };
    mocks.api.statistics.mockImplementation(async (params) => ({
      groups: [
        {
          data_source: 'demo',
          active_mode: 'webcam',
          policy_id: 'policy-demo',
          summary: valid,
          buckets: [
            {
              starts_at: '2026-11-01T04:00:00.000Z',
              ends_at: '2026-11-01T05:00:00.000Z',
              metrics: valid,
            },
          ],
        },
        {
          data_source: 'real',
          active_mode: 'airpods',
          policy_id: 'policy-real',
          summary: empty,
          buckets: [
            {
              starts_at: '2026-11-01T03:00:00.000Z',
              ends_at: '2026-11-01T04:00:00.000Z',
              metrics: empty,
            },
          ],
        },
      ]
        .reverse()
        .filter((group) => !params.mode || group.active_mode === params.mode),
      unassigned_unknown_duration_ms: 3000,
    }));
    setup();
    let table = await screen.findByRole('table', { name: '기간별 통계' });
    let rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('웹캠');
    expect(rows[1]).toHaveTextContent('policy-demo');
    expect(rows[1]).toHaveTextContent('테스트');
    expect(within(rows[1]).getAllByText('50.0%')).toHaveLength(2);
    expect(rows[2]).toHaveTextContent('AirPods');
    expect(rows[2]).toHaveTextContent('policy-real');
    expect(rows[2]).toHaveTextContent('실제');
    expect(within(rows[2]).getAllByText('—')).toHaveLength(2);
    expect(screen.getByText(/미분류.*0분 3초/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('단위'), { target: { value: 'hour' } });
    await waitFor(() =>
      expect(mocks.api.statistics).toHaveBeenLastCalledWith(
        expect.objectContaining({ group_by: 'hour' }),
      ),
    );
    table = await screen.findByRole('table', { name: '기간별 통계' });
    rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('13:00');
    fireEvent.change(screen.getByLabelText('방식'), { target: { value: 'webcam' } });
    await waitFor(() =>
      expect(mocks.api.statistics).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: 'webcam' }),
      ),
    );
    await waitFor(() => expect(screen.queryByText(/미분류/)).not.toBeInTheDocument());
  });

  it('shows unassigned time instead of saying there are no records', async () => {
    mocks.api.statistics.mockResolvedValue({ groups: [], unassigned_unknown_duration_ms: 5000 });
    setup();
    const value = await screen.findByText(/미분류.*0분 5초/);
    const section = value.closest('section');
    expect(section).not.toBeNull();
    expect(within(section!).queryByText('기록 없음')).not.toBeInTheDocument();
  });

  it('does not round a positive sub-second unassigned interval down to zero', async () => {
    mocks.api.statistics.mockResolvedValue({ groups: [], unassigned_unknown_duration_ms: 500 });
    setup();
    expect(await screen.findByText(/미분류.*1초 미만/)).toBeInTheDocument();
  });
});
