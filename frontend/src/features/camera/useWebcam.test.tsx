import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cameraPipeline } from '../measurement/camera-pipeline';
import { useMeasurement } from '../../state/measurement';
import { stopBackgroundCamera, useBackgroundCamera } from './background-camera';
import { useWebcam } from './useWebcam';

const track = {
  readyState: 'live',
  stop: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  getSettings: () => ({ width: 1280, height: 720 }),
};
const stream = {
  getTracks: () => [track],
  getVideoTracks: () => [track],
} as unknown as MediaStream;

function setHidden(value: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value });
}

beforeEach(() => {
  track.stop.mockReset();
  setHidden(false);
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  setHidden(false);
  vi.restoreAllMocks();
});

async function startCamera(keepWhenHidden: boolean) {
  const hook = renderHook(() => useWebcam({ keepWhenHidden }));
  hook.result.current.videoRef.current = document.createElement('video');
  await act(() => hook.result.current.start());
  await waitFor(() => expect(hook.result.current.status).toBe('playing'));
  setHidden(true);
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  return hook;
}

test('a plain preview turns the camera off when the tab is hidden', async () => {
  const hook = await startCamera(false);
  expect(hook.result.current.status).toBe('stopped');
  expect(track.stop).toHaveBeenCalled();
});

test('analysis pages keep the camera on in the background', async () => {
  const hook = await startCamera(true);
  expect(hook.result.current.status).toBe('playing');
  expect(hook.result.current.message).toContain('다른 메뉴로 옮겨도');
  expect(track.stop).not.toHaveBeenCalled();
});

describe('moving to another page during a camera measurement', () => {
  beforeEach(() => {
    vi.spyOn(cameraPipeline, 'attach').mockImplementation(() => undefined);
    useMeasurement.setState({ input: 'camera', phase: 'active' });
  });
  afterEach(() => {
    stopBackgroundCamera();
    useMeasurement.setState({ input: 'demo', phase: 'idle' });
  });

  async function playingHook() {
    const hook = renderHook(() => useWebcam({ keepWhenHidden: true }));
    hook.result.current.videoRef.current = document.createElement('video');
    await act(() => hook.result.current.start());
    await waitFor(() => expect(hook.result.current.status).toBe('playing'));
    return hook;
  }

  test('keeps the stream analysed off-page and hands it back to the next preview', async () => {
    const first = await playingHook();
    first.unmount();
    expect(track.stop).not.toHaveBeenCalled();
    expect(useBackgroundCamera.getState().on).toBe(true);
    const offPage = document.querySelector<HTMLVideoElement>('video[data-background-camera]');
    expect(offPage?.srcObject).toBe(stream);
    expect(cameraPipeline.attach).toHaveBeenLastCalledWith(offPage);

    const next = renderHook(() => {
      const camera = useWebcam({ keepWhenHidden: true });
      if (!camera.videoRef.current) camera.videoRef.current = document.createElement('video');
      return camera;
    });
    expect(next.result.current.status).toBe('playing');
    expect(next.result.current.videoRef.current?.srcObject).toBe(stream);
    expect(useBackgroundCamera.getState().on).toBe(false);
    expect(document.querySelector('video[data-background-camera]')).toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
  });

  test('the off-page stop button turns the camera off but leaves the measurement running', async () => {
    (await playingHook()).unmount();
    stopBackgroundCamera();
    expect(track.stop).toHaveBeenCalled();
    expect(useBackgroundCamera.getState().on).toBe(false);
    expect(useMeasurement.getState().phase).toBe('active');
  });

  test('ending the measurement off-page releases the camera', async () => {
    (await playingHook()).unmount();
    useMeasurement.setState({ phase: 'completed' });
    expect(track.stop).toHaveBeenCalled();
    expect(useBackgroundCamera.getState().on).toBe(false);
  });

  test('after calibration, leaving the page keeps the camera for the measurement page', async () => {
    useMeasurement.setState({ phase: 'idle' });
    vi.spyOn(cameraPipeline, 'hasBaseline', 'get').mockReturnValue(true);
    (await playingHook()).unmount();
    expect(track.stop).not.toHaveBeenCalled();
    expect(useBackgroundCamera.getState().on).toBe(true);
    // Starting and then finishing a measurement afterwards releases it.
    useMeasurement.setState({ phase: 'active' });
    useMeasurement.setState({ phase: 'completed' });
    expect(track.stop).toHaveBeenCalled();
  });

  test('without a running measurement, leaving the page still turns the camera off', async () => {
    useMeasurement.setState({ phase: 'idle' });
    (await playingHook()).unmount();
    expect(track.stop).toHaveBeenCalled();
    expect(useBackgroundCamera.getState().on).toBe(false);
  });
});
