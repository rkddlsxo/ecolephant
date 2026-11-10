import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraModelResult, PostureModelAdapter } from './model-adapter';
import { CameraPipeline, useCameraPipeline } from './camera-pipeline';

/** Synthetic upright pose; `forward` widens the ears (head closer), `drop` lowers them. */
function pose(t: number, { forward = 0, drop = 0, quality = 'valid' } = {}): CameraModelResult {
  const half = 0.06 * (1 + forward);
  const p = (x: number, y: number) => ({ x, y, confidence: 0.95 });
  return {
    timestampMs: t,
    frameWidth: 640,
    frameHeight: 480,
    quality: quality as CameraModelResult['quality'],
    landmarks: {
      nose: p(0.5, 0.33 + drop),
      leftEar: p(0.5 + half, 0.35 + drop),
      rightEar: p(0.5 - half, 0.35 + drop),
      leftShoulder: p(0.7, 0.6),
      rightShoulder: p(0.3, 0.6),
    },
  };
}

function fakeAdapter(shape: { current: { forward?: number; drop?: number; quality?: string } }) {
  const analyze = vi.fn(async (_video: HTMLVideoElement, t: number) => pose(t, shape.current));
  const adapter = {
    delegate: 'GPU' as const,
    load: vi.fn(async (): Promise<void> => undefined),
    analyze,
    close: vi.fn(),
  } satisfies PostureModelAdapter & { delegate: 'GPU' };
  return adapter;
}

const video = {} as HTMLVideoElement;

describe('CameraPipeline', () => {
  let shape: { current: { forward?: number; drop?: number; quality?: string } };
  let adapter: ReturnType<typeof fakeAdapter>;
  let pipeline: CameraPipeline;

  beforeEach(() => {
    vi.useFakeTimers();
    shape = { current: {} };
    adapter = fakeAdapter(shape);
    pipeline = new CameraPipeline({ createAdapter: () => adapter, now: () => Date.now() });
  });

  afterEach(() => {
    pipeline.reset();
    vi.useRealTimers();
  });

  it('stores a baseline after a stable 3 s segment and keeps it on the device', async () => {
    pipeline.attach(video);
    await vi.advanceTimersByTimeAsync(500);
    expect(useCameraPipeline.getState().status).toBe('running');
    expect(pipeline.hasBaseline).toBe(false);
    pipeline.beginCalibration();
    await vi.advanceTimersByTimeAsync(3500);
    expect(pipeline.hasBaseline).toBe(true);
    expect(pipeline.calibrating).toBe(false);
    expect(useCameraPipeline.getState()).toMatchObject({ hasBaseline: true, calibrating: false });
  });

  it('turns analysed frames into change values for a 1 s window', async () => {
    pipeline.attach(video);
    pipeline.beginCalibration();
    await vi.advanceTimersByTimeAsync(4000);
    shape.current = { forward: 0.3 };
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(1000);
    const observed = pipeline.observe(start, start + 1000);
    expect(observed.quality).toBeUndefined();
    expect(observed.cameraChange?.forward).toBeCloseTo(0.3, 2);
    expect(observed.cameraChange?.drop).toBeCloseTo(0, 2);
    // Only derived numbers leave the pipeline.
    expect(JSON.stringify(observed)).not.toMatch(/landmarks|leftEar|confidence/);
  });

  it('reports missing or moving windows instead of a normal posture', async () => {
    expect(pipeline.observe(0, 1000)).toEqual({ cameraChange: null, quality: 'no_sensor' });
    pipeline.attach(video);
    pipeline.beginCalibration();
    await vi.advanceTimersByTimeAsync(4000);
    const empty = Date.now() + 60_000;
    expect(pipeline.observe(empty, empty + 1000)).toMatchObject({ quality: 'no_sensor' });
    shape.current = { quality: 'motion' };
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pipeline.observe(start, start + 1000)).toEqual({
      cameraChange: null,
      quality: 'motion',
    });
  });

  it('restarts calibration with a reason when the person moves', async () => {
    pipeline.attach(video);
    pipeline.beginCalibration();
    shape.current = { quality: 'motion' };
    await vi.advanceTimersByTimeAsync(1000);
    expect(pipeline.hasBaseline).toBe(false);
    expect(useCameraPipeline.getState().lastRestart).toBe('motion');
  });

  it('stops analysing when the video is detached', async () => {
    pipeline.attach(video);
    await vi.advanceTimersByTimeAsync(500);
    const calls = adapter.analyze.mock.calls.length;
    pipeline.attach(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.analyze.mock.calls.length).toBe(calls);
    expect(useCameraPipeline.getState().status).toBe('off');
  });

  it('shows an error when the model cannot be loaded', async () => {
    adapter.load = vi.fn(async () => {
      throw new Error('404');
    });
    pipeline.attach(video);
    await vi.advanceTimersByTimeAsync(100);
    expect(useCameraPipeline.getState()).toMatchObject({ status: 'error' });
    expect(useCameraPipeline.getState().error).toMatch(/pose:assets/);
  });
});
