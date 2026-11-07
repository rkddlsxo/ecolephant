import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discardMissing: vi.fn(() => true),
  start: vi.fn(() => Promise.resolve()),
  policyCheck: {
    status: 'ok',
    server: { release_approved: false, camera_mapping_status: 'unvalidated' },
  } as { status: string; message?: string; server?: object },
}));
vi.mock('../features/measurement/policy', () => ({ usePolicyCheck: () => mocks.policyCheck }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock('../features/measurement/controller', () => ({
  measurement: { discardMissing: mocks.discardMissing, start: mocks.start },
}));
import { MeasurePage } from './MeasurePage';
import { initialMeasurement, useMeasurement } from '../state/measurement';

afterEach(() => {
  cleanup();
  useMeasurement.setState({ ...initialMeasurement }, true);
  mocks.policyCheck = {
    status: 'ok',
    server: { release_approved: false, camera_mapping_status: 'unvalidated' },
  };
  vi.clearAllMocks();
});

it('blocks starting when the server policy does not match', () => {
  mocks.policyCheck = { status: 'blocked', message: '서버에 정책 draft-web-v0 (0.1)이 없어' };
  render(<MeasurePage />);
  expect(screen.getByRole('alert')).toHaveTextContent('서버에 정책');
  const start = screen.getByRole('button', { name: '시작' });
  expect(start).toBeDisabled();
  fireEvent.click(start);
  expect(mocks.start).not.toHaveBeenCalled();
});

it('waits for the policy check before allowing start', () => {
  mocks.policyCheck = { status: 'loading' };
  render(<MeasurePage />);
  expect(screen.getByRole('button', { name: '정책 확인 중' })).toBeDisabled();
});

it('starts once the server policy matches', () => {
  render(<MeasurePage />);
  expect(screen.getByText(/판정 기준은 검증 전 초안/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '시작' }));
  expect(mocks.start).toHaveBeenCalledWith('webcam');
});

it('requires confirmation before discarding a missing session and its pending data', () => {
  useMeasurement.setState({
    phase: 'ending',
    missingSession: true,
    pending: 3,
    error: '기록을 찾을 수 없어 저장할 수 없습니다.',
  });
  render(<MeasurePage />);
  expect(screen.getByRole('alert')).toHaveTextContent('저장할 수 없습니다');
  expect(screen.queryByRole('button', { name: '저장 재시도' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '시작' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '측정 정리' }));
  let dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('저장하지 못한 결과가 지워집니다');
  fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
  expect(mocks.discardMissing).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '측정 정리' }));
  dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: '정리' }));
  expect(mocks.discardMissing).toHaveBeenCalledOnce();
});

it('shows the start button with zeroed values right after saving', () => {
  useMeasurement.setState({
    phase: 'completed',
    session: { id: 'saved' } as never,
    elapsedMs: 0,
    latest: null,
    pending: 0,
  });
  render(<MeasurePage />);
  expect(screen.getByRole('button', { name: '시작' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: /종료·저장/ })).not.toBeInTheDocument();
  expect(screen.getByText('대기')).toBeInTheDocument();
  expect(screen.getByText('0개')).toBeInTheDocument();
});

it('always shows the link to saved records, even before any measurement', () => {
  render(<MeasurePage />);
  expect(screen.getByText('저장된 기록 보러가기')).toBeInTheDocument();
});

it('offers recalibration only while paused and shows progress while recalibrating', () => {
  useMeasurement.setState({ phase: 'active' });
  render(<MeasurePage />);
  expect(screen.queryByRole('button', { name: '기준 재설정' })).not.toBeInTheDocument();
  cleanup();
  useMeasurement.setState({ phase: 'paused' });
  render(<MeasurePage />);
  expect(screen.getByRole('button', { name: '기준 재설정' })).toBeEnabled();
  cleanup();
  useMeasurement.setState({ phase: 'recalibrating' });
  render(<MeasurePage />);
  expect(screen.getByText('기준 재설정 중')).toBeInTheDocument();
  expect(screen.getByText(/3초 동안 가만히/)).toBeInTheDocument();
});
