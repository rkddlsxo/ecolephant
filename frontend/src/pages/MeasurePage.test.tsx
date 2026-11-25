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
import { initialPipelineView, useCameraPipeline } from '../features/measurement/camera-pipeline';

/** Camera turned on and baseline taken on the calibration page. */
function cameraReady() {
  useCameraPipeline.setState({ status: 'running', hasBaseline: true });
}

afterEach(() => {
  cleanup();
  useMeasurement.setState({ ...initialMeasurement }, true);
  useCameraPipeline.setState({ ...initialPipelineView }, true);
  mocks.policyCheck = {
    status: 'ok',
    server: { release_approved: false, camera_mapping_status: 'unvalidated' },
  };
  vi.clearAllMocks();
});

it('blocks starting when the server policy does not match', () => {
  cameraReady();
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
  cameraReady();
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
  cameraReady();
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
  expect(screen.queryByRole('button', { name: '표준 자세 다시 등록' })).not.toBeInTheDocument();
  cleanup();
  useMeasurement.setState({ phase: 'paused' });
  render(<MeasurePage />);
  expect(screen.getByRole('button', { name: '표준 자세 다시 등록' })).toBeEnabled();
  cleanup();
  useMeasurement.setState({ phase: 'recalibrating' });
  render(<MeasurePage />);
  expect(screen.getByText('표준 자세 다시 등록 중')).toBeInTheDocument();
  expect(screen.getByText(/3초 동안 가만히/)).toBeInTheDocument();
});

it('measures with the real camera only, without a preview or input choice', () => {
  render(<MeasurePage />);
  expect(useMeasurement.getState().input).toBe('camera');
  expect(screen.getByRole('heading', { name: '사용자 측정' })).toBeInTheDocument();
  expect(screen.queryByLabelText('실시간 웹캠 미리보기')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^입력 / })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^측정 방식 / })).not.toBeInTheDocument();
  expect(screen.queryByText('테스트 입력')).not.toBeInTheDocument();
  expect(screen.getByText(/서버에는 판정 결과와 변화량 숫자만/)).toBeInTheDocument();
});

it('sends the user to calibration while the camera is off or there is no baseline', () => {
  render(<MeasurePage />);
  expect(screen.getByText(/카메라가 꺼져 있어요/)).toBeInTheDocument();
  expect(screen.getByText('표준 자세 등록으로')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '표준 자세를 먼저 등록해 주세요' })).toBeDisabled();
  cleanup();
  useCameraPipeline.setState({ status: 'running', hasBaseline: false });
  render(<MeasurePage />);
  expect(screen.getByText(/아직 표준 자세가 없어요/)).toBeInTheDocument();
  cleanup();
  cameraReady();
  render(<MeasurePage />);
  expect(screen.queryByText('표준 자세 등록으로')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '시작' })).toBeEnabled();
});

it('shows the posture type next to the level', () => {
  useMeasurement.setState({
    phase: 'active',
    latest: {
      seq: 1,
      elapsed_start_ms: 0,
      duration_ms: 1000,
      calibration_epoch: 1,
      active_mode: 'webcam',
      quality: 'valid',
      camera_estimate_deg: null,
      head_flexion_deg: null,
      display_angle_deg: null,
      posture_level: 'caution',
      reason_code: 'mixed_caution',
      confidence: 'single_sensor',
      camera_forward_change: 0.12,
      camera_drop_change: 0,
      camera_nose_drop_change: null,
      posture_type: 'chin_forward',
    },
  });
  render(<MeasurePage />);
  expect(screen.getByText('주의 · 거북목 자세')).toBeInTheDocument();
});

it('shows the kept camera and its off button in the same notice spot', async () => {
  const { useBackgroundCamera } = await import('../features/camera/background-camera');
  const off = vi
    .spyOn(await import('../features/camera/background-camera'), 'stopBackgroundCamera')
    .mockImplementation(() => useBackgroundCamera.setState({ on: false }));
  cameraReady();
  useBackgroundCamera.setState({ on: true });
  render(<MeasurePage />);
  expect(screen.getByText(/카메라 켜짐 · 표준 자세 등록됨/)).toBeInTheDocument();
  expect(screen.queryByText('표준 자세 등록으로')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '카메라 끄기' }));
  expect(off).toHaveBeenCalled();
  useBackgroundCamera.setState({ on: false });
});

it('says the windows are not judged when the camera is turned off mid-measurement', () => {
  useMeasurement.setState({ phase: 'active', input: 'camera' });
  render(<MeasurePage />);
  expect(screen.getByText(/판단 불가로 기록돼요/)).toBeInTheDocument();
  expect(screen.getByText('표준 자세 등록으로')).toBeInTheDocument();
});
