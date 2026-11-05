import { describe, expect, it } from 'vitest';
import {
  cameraFeatures,
  featureChange,
  type CameraFrame,
  type CameraPoint,
} from './camera-features';

const p = (x: number, y: number, confidence = 0.95): CameraPoint => ({ x, y, confidence });

function frame(
  overrides: Partial<CameraFrame['landmarks']> = {},
  extra: Partial<CameraFrame> = {},
) {
  return {
    timestampMs: 1000,
    frameWidth: 1280,
    frameHeight: 720,
    quality: 'valid',
    landmarks: {
      nose: p(0.5, 0.35),
      leftEar: p(0.55, 0.33),
      rightEar: p(0.45, 0.33),
      leftShoulder: p(0.65, 0.6),
      rightShoulder: p(0.35, 0.6),
      ...overrides,
    },
    ...extra,
  } satisfies CameraFrame;
}

describe('camera features', () => {
  it('computes r and h in pixel space', () => {
    const result = cameraFeatures(frame());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // face 0.10*1280=128px, shoulders 0.30*1280=384px, height gap 0.27*720=194.4px
    expect(result.features.r).toBeCloseTo(128 / 384, 6);
    expect(result.features.h).toBeCloseTo(194.4 / 384, 6);
    expect(result.features.timestampMs).toBe(1000);
  });

  it('uses the real frame size, not raw normalized distances', () => {
    const wide = cameraFeatures(frame());
    const tall = cameraFeatures(frame({}, { frameWidth: 720, frameHeight: 1280 }));
    if (!wide.ok || !tall.ok) throw new Error('expected features');
    expect(wide.features.r).toBeCloseTo(tall.features.r, 6); // horizontal ratio unchanged
    expect(tall.features.h).toBeGreaterThan(wide.features.h); // vertical gap scales with height
  });

  it('keeps mirrored-equivalent input symmetric (left/right swapped gives the same features)', () => {
    const swapped = cameraFeatures(
      frame({
        leftEar: p(0.45, 0.33),
        rightEar: p(0.55, 0.33),
        leftShoulder: p(0.35, 0.6),
        rightShoulder: p(0.65, 0.6),
      }),
    );
    const normal = cameraFeatures(frame());
    if (!swapped.ok || !normal.ok) throw new Error('expected features');
    expect(swapped.features).toEqual(normal.features);
  });

  it('does not upgrade low quality frames', () => {
    for (const quality of ['no_pose', 'low_confidence', 'motion'] as const)
      expect(cameraFeatures(frame({}, { quality }))).toEqual({ ok: false, reason: quality });
  });

  it('requires both ears and both shoulders above the confidence minimum', () => {
    expect(cameraFeatures(frame({ leftEar: null }))).toEqual({
      ok: false,
      reason: 'missing_points',
    });
    expect(cameraFeatures(frame({ rightShoulder: p(0.35, 0.6, 0.69) }))).toEqual({
      ok: false,
      reason: 'missing_points',
    });
    expect(cameraFeatures(frame({ rightShoulder: p(0.35, 0.6, 0.7) })).ok).toBe(true);
  });

  it('rejects a near-zero shoulder width instead of dividing by it', () => {
    expect(
      cameraFeatures(frame({ leftShoulder: p(0.51, 0.6), rightShoulder: p(0.49, 0.6) })),
    ).toEqual({ ok: false, reason: 'degenerate' });
    expect(cameraFeatures(frame({ leftEar: p(0.5, 0.33), rightEar: p(0.5, 0.33) }))).toEqual({
      ok: false,
      reason: 'degenerate',
    });
  });

  it('reports change from the baseline without converting to degrees', () => {
    const result = cameraFeatures(frame());
    if (!result.ok) throw new Error('expected features');
    const change = featureChange(result.features, {
      r0: result.features.r / 1.1,
      h0: result.features.h + 0.05,
    });
    expect(change.rChange).toBeCloseTo(0.1, 6);
    expect(change.hChange).toBeCloseTo(-0.05, 6);
    expect(Object.keys(change).sort()).toEqual(['hChange', 'rChange']);
  });
});
