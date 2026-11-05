import { describe, expect, it, vi } from 'vitest';
import {
  createMediaPipeAdapter,
  VideoNotReadyError,
  type PoseLandmarkerLike,
} from './mediapipe-adapter';
import type { RawLandmark } from './pose-result';

function video({ width = 1280, height = 720, readyState = 4 } = {}) {
  return { videoWidth: width, videoHeight: height, readyState } as unknown as HTMLVideoElement;
}

function fullPose(): RawLandmark[] {
  const points: RawLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    visibility: 0.9,
  }));
  points[11] = { x: 0.65, y: 0.6, visibility: 0.95 };
  points[12] = { x: 0.35, y: 0.6, visibility: 0.95 };
  return points;
}

function fakeLandmarker(poses: RawLandmark[][] = [fullPose()]) {
  const detect = vi.fn<PoseLandmarkerLike['detectForVideo']>(() => ({ landmarks: poses }));
  const close = vi.fn();
  const landmarker: PoseLandmarkerLike = { detectForVideo: detect, close };
  return { landmarker, detect, close };
}

describe('MediaPipe pose adapter', () => {
  it('loads once, prefers GPU, and returns contract results', async () => {
    const fake = fakeLandmarker();
    const factory = vi.fn(async () => fake.landmarker);
    const adapter = createMediaPipeAdapter({ factory });
    await Promise.all([adapter.load(), adapter.load()]);
    await adapter.load();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('GPU', 'lite');
    expect(adapter.delegate).toBe('GPU');

    const result = await adapter.analyze(video(), 1234.5);
    expect(result).toMatchObject({ timestampMs: 1234.5, frameWidth: 1280, frameHeight: 720 });
    expect(result.quality).toBe('valid');
    expect(Object.keys(result).sort()).toEqual(
      ['frameHeight', 'frameWidth', 'landmarks', 'quality', 'timestampMs'].sort(),
    );
  });

  it('passes the model variant and exposes raw points only to the debug hook', async () => {
    const fake = fakeLandmarker();
    const factory = vi.fn(async () => fake.landmarker);
    const onRawPose = vi.fn();
    const adapter = createMediaPipeAdapter({ factory, variant: 'full', onRawPose });
    await adapter.load();
    expect(factory).toHaveBeenCalledWith('GPU', 'full');
    const result = await adapter.analyze(video(), 10);
    expect(onRawPose.mock.calls[0][0]).toHaveLength(33);
    expect(JSON.stringify(result)).not.toContain('"z"');
  });

  it('falls back to CPU when GPU initialisation fails', async () => {
    const fake = fakeLandmarker();
    const factory = vi.fn(async (delegate: 'GPU' | 'CPU') => {
      if (delegate === 'GPU') throw new Error('no webgl');
      return fake.landmarker;
    });
    const adapter = createMediaPipeAdapter({ factory });
    await adapter.load();
    expect(factory.mock.calls.map(([d]) => d)).toEqual(['GPU', 'CPU']);
    expect(adapter.delegate).toBe('CPU');
  });

  it('rejects analysis before load and when the video has no frame', async () => {
    const fake = fakeLandmarker();
    const adapter = createMediaPipeAdapter({ factory: async () => fake.landmarker });
    await expect(adapter.analyze(video(), 1)).rejects.toThrow('not loaded');
    await adapter.load();
    await expect(adapter.analyze(video({ readyState: 1 }), 1)).rejects.toBeInstanceOf(
      VideoNotReadyError,
    );
    await expect(adapter.analyze(video({ width: 0 }), 1)).rejects.toBeInstanceOf(
      VideoNotReadyError,
    );
    expect(fake.detect).not.toHaveBeenCalled();
  });

  it('passes strictly increasing timestamps to MediaPipe', async () => {
    const fake = fakeLandmarker();
    const adapter = createMediaPipeAdapter({ factory: async () => fake.landmarker });
    await adapter.load();
    await adapter.analyze(video(), 100.2);
    await adapter.analyze(video(), 100.4);
    await adapter.analyze(video(), 90);
    expect(fake.detect.mock.calls.map(([, ts]) => ts)).toEqual([100, 101, 102]);
  });

  it('reports no_pose when the model finds nobody', async () => {
    const fake = fakeLandmarker([]);
    const adapter = createMediaPipeAdapter({ factory: async () => fake.landmarker });
    await adapter.load();
    expect((await adapter.analyze(video(), 5)).quality).toBe('no_pose');
  });

  it('releases the model on close and can load again', async () => {
    const first = fakeLandmarker();
    const second = fakeLandmarker();
    const factory = vi
      .fn<(d: 'GPU' | 'CPU', v: string) => Promise<PoseLandmarkerLike>>()
      .mockResolvedValueOnce(first.landmarker)
      .mockResolvedValueOnce(second.landmarker);
    const adapter = createMediaPipeAdapter({ factory });
    await adapter.load();
    adapter.close();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(adapter.delegate).toBeNull();
    await expect(adapter.analyze(video(), 1)).rejects.toThrow('not loaded');
    await adapter.load();
    await adapter.analyze(video(), 1);
    expect(second.detect).toHaveBeenCalledTimes(1);
  });

  it('closes a model that finishes loading after close was called', async () => {
    const fake = fakeLandmarker();
    let resolve!: (value: PoseLandmarkerLike) => void;
    const adapter = createMediaPipeAdapter({
      factory: () => new Promise((done) => (resolve = done)),
    });
    const loading = adapter.load();
    adapter.close();
    resolve(fake.landmarker);
    await loading;
    expect(fake.close).toHaveBeenCalledTimes(1);
    await expect(adapter.analyze(video(), 1)).rejects.toThrow('not loaded');
  });
});
