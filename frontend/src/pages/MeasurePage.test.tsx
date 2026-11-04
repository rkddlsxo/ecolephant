import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ discardMissing: vi.fn(() => true) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock('../features/measurement/controller', () => ({
  measurement: { discardMissing: mocks.discardMissing },
}));
import { MeasurePage } from './MeasurePage';
import { initialMeasurement, useMeasurement } from '../state/measurement';

afterEach(() => {
  cleanup();
  useMeasurement.setState({ ...initialMeasurement }, true);
  vi.clearAllMocks();
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
