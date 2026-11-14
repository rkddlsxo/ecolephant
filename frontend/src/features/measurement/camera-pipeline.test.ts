import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraModelResult, PostureModelAdapter } from './model-adapter';
import { CameraPipeline, useCameraPipeline } from './camera-pipeline';

/** Synthetic upright pose; `forward` widens the ears (head closer), `drop` lowers them. */
function pose(
  t: number,
  { forward = 0, drop = 0, quality = 'valid', shoulder = 0.2 } = {},
): CameraModelResult {
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
      leftShoulder: p(0.5 + shoulder, 0.6),
      rightShoulder: p(0.5 - shoulder, 0.6),
    },
  };
}

interface Shape {
  forward?: number;
  drop?: number;
  quality?: string;
  shoulder?: number;
}

function fakeAdapter(shape: { current: Shape }) {
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
  let shape: { current: Shape };
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

  it('accepts a single analysed frame per window only while the page is hidden', async () => {
    let hidden = false;
    const hiddenPipeline = new CameraPipeline({
      createAdapter: () => adapter,
      now: () => Date.now(),
      requireGuide: false,
      hiddenAnalysis: () => hidden,
    });
    hiddenPipeline.attach(video);
    hiddenPipeline.beginCalibration();
    await vi.advanceTimersByTimeAsync(4000);
    shape.current = { forward: 0.3 };
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(1000);
    // A slice holding one analysed frame stands in for a hidden tab's 1 fps window.
    const one = start + 500;
    const slice: [number, number] = [one, one + 1000 / 15];
    expect(hiddenPipeline.observe(...slice)).toEqual({ cameraChange: null, quality: 'no_sensor' });
    hidden = true;
    expect(hiddenPipeline.observe(...slice).cameraChange?.forward).toBeCloseTo(0.3, 2);
    // Still never normal without data.
    const empty = Date.now() + 60_000;
    expect(hiddenPipeline.observe(empty, empty + 1000)).toMatchObject({ quality: 'no_sensor' });
    hiddenPipeline.reset();
  });

  it('restarts calibration with a reason when the person moves', async () => {
    pipeline.attach(video);
    pipeline.beginCalibration();
    shape.current = { quality: 'motion' };
    await vi.advanceTimersByTimeAsync(1000);
    expect(pipeline.hasBaseline).toBe(false);
    expect(useCameraPipeline.getState().lastRestart).toBe('motion');
  });

  it('only takes the baseline inside the person-shaped guide', async () => {
    pipeline.attach(video);
    // Shoulders 0.2 of the width apart: sitting too far from the camera.
    shape.current = { shoulder: 0.1 };
    pipeline.beginCalibration();
    await vi.advanceTimersByTimeAsync(4000);
    expect(pipeline.hasBaseline).toBe(false);
    expect(useCameraPipeline.getState()).toMatchObject({ guide: 'too_far', progress: 0 });
    shape.current = {};
    await vi.advanceTimersByTimeAsync(4000);
    expect(pipeline.hasBaseline).toBe(true);
    expect(useCameraPipeline.getState().guide).toBe('ok');
  });

  it('can calibrate without the guide when it is turned off', async () => {
    const free = new CameraPipeline({
      createAdapter: () => adapter,
      now: () => Date.now(),
      requireGuide: false,
    });
    shape.current = { shoulder: 0.1 };
    free.attach(video);
    free.beginCalibration();
    await vi.advanceTimersByTimeAsync(4000);
    expect(free.hasBaseline).toBe(true);
    free.reset();
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
