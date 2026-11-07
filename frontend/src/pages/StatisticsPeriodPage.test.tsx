import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: { statistics: vi.fn(), sessions: vi.fn() },
  search: {} as Record<string, string>,
  navigate: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: { back: vi.fn() } }),
}));
vi.mock('../api/client', () => ({ api: mocks.api, errorMessage: () => '조회에 실패했습니다.' }));
import { StatisticsPeriodPage } from './StatisticsPeriodPage';

const metrics = {
  valid_duration_ms: 120000,
  normal_duration_ms: 60000,
  caution_duration_ms: 30000,
  high_duration_ms: 30000,
  forward_head_suspected_ms: 0,
  mean_display_angle_deg: 10,
  within_range_percent: 50,
  first_stage_alert_count: 2,
  corrected_alert_count: 1,
  unknown_correction_count: 1,
  mean_correction_ms: 4000,
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StatisticsPeriodPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('shows the summary, hourly breakdown and sessions of the selected day', async () => {
  mocks.search = {
    from: '2026-11-05T15:00:00.000Z',
    to: '2026-11-06T15:00:00.000Z',
    mode: 'webcam',
  };
  mocks.api.statistics.mockResolvedValue({
    groups: [
      {
        data_source: 'demo',
        active_mode: 'webcam',
        policy_id: 'draft-web-v0',
        summary: metrics,
        buckets: [
          { starts_at: '2026-11-06T01:00:00.000Z', ends_at: '2026-11-06T02:00:00.000Z', metrics },
        ],
      },
    ],
    unassigned_unknown_duration_ms: 0,
  });
  mocks.api.sessions.mockResolvedValue({
    items: [
      {
        id: 's1',
        started_at: '2026-11-06T01:10:00.000Z',
        ended_at: '2026-11-06T01:12:00.000Z',
        requested_mode: 'webcam',
        status: 'completed',
        data_source: 'demo',
      },
    ],
    next_cursor: null,
  });
  setup();
  expect(await screen.findByRole('heading', { name: /11월 6일.*통계/ })).toBeInTheDocument();
  expect(mocks.api.statistics).toHaveBeenCalledWith({
    from: '2026-11-05T15:00:00.000Z',
    to: '2026-11-06T15:00:00.000Z',
    mode: 'webcam',
    group_by: 'hour',
    timezone: 'Asia/Seoul',
    include_active: 'true',
  });
  // 요약: 상세 페이지와 같은 타일 구성
  const tiles = (await screen.findByText('유효 측정 시간')).closest('.stats-tiles') as HTMLElement;
  expect(within(tiles).getByText('2분 0초')).toBeInTheDocument();
  expect(within(tiles).getByText('50.0%')).toBeInTheDocument();
  // 시간대별 표만 있고 '전체' 표는 요약과 겹쳐서 숨김
  const hourly = screen.getByRole('table', { name: '기간별 통계' });
  expect(within(hourly).getAllByRole('row')).toHaveLength(2);
  expect(screen.queryByRole('table', { name: '전체 통계' })).not.toBeInTheDocument();
  // 이 기간에 시작한 세션
  expect(await screen.findByText(/웹캠 · 2분 0초/)).toBeInTheDocument();
});

it('opens a whole-range period split by day', async () => {
  mocks.search = { from: '2026-10-31T15:00:00.000Z', to: '2026-11-07T15:00:00.000Z' };
  mocks.api.statistics.mockResolvedValue({ groups: [], unassigned_unknown_duration_ms: 0 });
  mocks.api.sessions.mockResolvedValue({ items: [], next_cursor: null });
  setup();
  expect(
    await screen.findByRole('heading', { name: /11월 1일.*~ 11월 7일.*통계/ }),
  ).toBeInTheDocument();
  expect(mocks.api.statistics).toHaveBeenCalledWith(expect.objectContaining({ group_by: 'day' }));
  expect(screen.getByText(/전체 방식 · 이 기간 동안/)).toBeInTheDocument();
});

it('explains when the address has no period', () => {
  mocks.search = {};
  setup();
  expect(screen.getByText('기간을 찾을 수 없어요.')).toBeInTheDocument();
});
