import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: { statistics: vi.fn() },
  createStatisticsPdf: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../features/pdf/statistics-report', () => ({
  createStatisticsPdf: mocks.createStatisticsPdf,
}));
vi.mock('../api/client', () => ({ api: mocks.api, errorMessage: () => '조회에 실패했습니다.' }));
import { StatisticsPage } from './StatisticsPage';

const metrics = (valid: number, within: number | null, alerts: number) => ({
  valid_duration_ms: valid,
  within_range_percent: within,
  high_duration_ms: 0,
  first_stage_alert_count: alerts,
  corrected_alert_count: alerts ? alerts - 1 : 0,
  mean_correction_ms: alerts ? 4000 : null,
});
const group = (active_mode: string, policy_id: string, valid: number, alerts: number) => ({
  active_mode,
  data_source: 'demo',
  policy_id,
  summary: metrics(valid, 50, alerts),
  buckets: [
    {
      starts_at: '2026-10-31T15:00:00Z',
      ends_at: '2026-11-01T15:00:00Z',
      metrics: metrics(valid, 50, alerts),
    },
  ],
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StatisticsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.api.statistics.mockResolvedValue({ groups: [], unassigned_unknown_duration_ms: 0 });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test('shows an empty state when there is nothing to chart', async () => {
  setup();
  expect(await screen.findByText(/이 기간에는 통계가 없어요/)).toBeInTheDocument();
});

test('sums additive totals across groups and charts ratios per group', async () => {
  mocks.api.statistics.mockResolvedValue({
    groups: [group('webcam', 'p1', 120000, 2), group('airpods', 'p2', 60000, 1)],
    unassigned_unknown_duration_ms: 5000,
  });
  setup();
  expect(await screen.findByText('3분 0초')).toBeInTheDocument();
  expect(screen.getByText('3회')).toBeInTheDocument();
  expect(screen.getByText('알림 후 자세 변화 1회')).toBeInTheDocument();
  expect(screen.getByText('0분 5초')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: /정상 범위 비율 추이/ })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: /유효 측정 시간/ })).toBeInTheDocument();
  expect(screen.getAllByText('웹캠 · 테스트').length).toBeGreaterThan(0);
  expect(screen.getAllByText(/웹캠 · 테스트 · 기준 p1/).length).toBeGreaterThan(0);
});

test('changing the mode filter requests that mode and hides unassigned time', async () => {
  mocks.api.statistics.mockResolvedValue({
    groups: [group('webcam', 'p1', 60000, 0)],
    unassigned_unknown_duration_ms: 5000,
  });
  setup();
  await screen.findAllByText('1분 0초');
  // 판정 기준이 하나뿐이면 표에 정책 ID를 붙이지 않음
  expect(screen.queryByText(/기준 p1/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^방식 / }));
  fireEvent.click(screen.getByRole('option', { name: '웹캠' }));
  await waitFor(() =>
    expect(mocks.api.statistics).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'webcam' }),
    ),
  );
  await waitFor(() => expect(screen.queryByText('0분 5초')).not.toBeInTheDocument());
});

test('starts with every filter on 전체 and lets in-progress sessions be excluded', async () => {
  setup();
  await screen.findByText(/이 기간에는 통계가 없어요/);
  const first = mocks.api.statistics.mock.calls[0]![0];
  expect(first).toMatchObject({ include_active: 'true', group_by: 'day' });
  expect(first.mode).toBeUndefined();
  expect(Date.parse(first.to) - Date.parse(first.from)).toBe(366 * 86400000);
  for (const label of ['기간', '방식', '세션 상태'])
    expect(screen.getByRole('button', { name: new RegExp(`^${label} `) })).toHaveTextContent(
      '전체',
    );
  fireEvent.click(screen.getByRole('button', { name: /^세션 상태 / }));
  fireEvent.click(screen.getByRole('option', { name: '완료만' }));
  await waitFor(() =>
    expect(mocks.api.statistics).toHaveBeenLastCalledWith(
      expect.objectContaining({ include_active: 'false' }),
    ),
  );
});

test('opens detailed statistics from both the total row and a period row', async () => {
  mocks.api.statistics.mockResolvedValue({
    groups: [group('webcam', 'p1', 60000, 0)],
    unassigned_unknown_duration_ms: 0,
  });
  setup();
  const total = await screen.findByRole('table', { name: '전체 통계' });
  fireEvent.click(within(total).getByTitle(/웹캠 전체 통계 보기/));
  const call = mocks.navigate.mock.calls[0]![0];
  expect(call).toMatchObject({ to: '/statistics/period', search: { mode: 'webcam' } });
  // 화면에서 조회한 기간(기본 '전체' = 최근 366일)
  expect(Date.parse(call.search.to) - Date.parse(call.search.from)).toBe(366 * 86400000);
  mocks.navigate.mockClear();

  const table = screen.getByRole('table', { name: '기간별 통계' });
  const row = within(table).getByTitle(/웹캠 통계 보기/);
  fireEvent.click(row);
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: '/statistics/period',
    search: { from: '2026-10-31T15:00:00Z', to: '2026-11-01T15:00:00Z', mode: 'webcam' },
  });
  fireEvent.keyDown(row, { key: 'Enter' });
  expect(mocks.navigate).toHaveBeenCalledTimes(2);
});

test('downloads a statistics PDF that uses the same filters and numbers as the screen', async () => {
  mocks.api.statistics.mockResolvedValue({
    groups: [group('webcam', 'p1', 120000, 2)],
    unassigned_unknown_duration_ms: 0,
  });
  mocks.createStatisticsPdf.mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }));
  const createObjectURL = vi.fn(() => 'blob:stats');
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL: vi.fn() }),
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  setup();
  await screen.findAllByText('2분 0초');
  fireEvent.click(screen.getByRole('button', { name: 'PDF로 저장' }));
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  const input = mocks.createStatisticsPdf.mock.calls[0][0];
  expect(input.filterLabel).toBe('전체 기간 · 전체 방식 · 일별');
  expect(input.view.totalValid).toBe(120000);
  expect(input.view.totalAlerts).toBe(2);
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toMatch(
    /^ecolephant-statistics-.*\.pdf$/,
  );
  vi.unstubAllGlobals();
  click.mockRestore();
});
