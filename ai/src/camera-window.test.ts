import { describe, expect, it } from 'vitest';
import type { CameraBaseline, FeatureResult } from './camera-features';
import policy from './policy.json';
import {
  cameraObservation,
  defaultCameraWindowOptions,
  draftCameraChangeThresholds,
  judgeCameraChange,
  summarizeCameraWindow,
  type CameraWindowSummary,
} from './camera-window';

const baseline: CameraBaseline = { r0: 0.4, h0: 0.5, n0: -0.2 };
const ok = (t: number, r = 0.4, h = 0.5, n: number | null = -0.2): FeatureResult => ({
  ok: true,
  features: { timestampMs: t, r, h, n },
});
const fail = (reason: 'motion' | 'missing_points' | 'low_confidence'): FeatureResult => ({
  ok: false,
  reason,
});
const frames = (count: number, make: (i: number) => FeatureResult) =>
  Array.from({ length: count }, (_, i) => make(i));

function valid(summary: CameraWindowSummary) {
  if (!summary.ok) throw new Error(`expected a valid window, got ${summary.reason}`);
  return summary;
}

describe('summarizeCameraWindow', () => {
  it('uses the median change of usable frames, so one outlier does not move it', () => {
    const results = frames(10, (i) => ok(i * 70, i === 3 ? 0.8 : 0.44, 0.45));
    const summary = valid(summarizeCameraWindow(results, baseline));
    expect(summary.rChange).toBeCloseTo(0.1, 6);
    expect(summary.hChange).toBeCloseTo(-0.05, 6);
    expect(summary.nChange).toBeCloseTo(0, 6);
    expect(summary).toMatchObject({ coverage: 1, frames: 10 });
  });

  it('reports no_sensor when too few frames were analysed', () => {
    expect(
      summarizeCameraWindow(
        frames(2, (i) => ok(i)),
        baseline,
      ),
    ).toEqual({
      ok: false,
      reason: 'no_sensor',
      coverage: 0,
      frames: 2,
    });
    expect(summarizeCameraWindow([], baseline)).toMatchObject({ ok: false, reason: 'no_sensor' });
  });

  it('does not fill a low-coverage window with normal values', () => {
    // 7 of 10 usable = 0.7 < 0.8
    const results = frames(10, (i) => (i < 7 ? ok(i) : fail('missing_points')));
    expect(summarizeCameraWindow(results, baseline)).toMatchObject({
      ok: false,
      reason: 'low_confidence',
      coverage: 0.7,
    });
    // exactly the minimum is accepted
    const enough = frames(10, (i) => (i < 8 ? ok(i) : fail('missing_points')));
    expect(summarizeCameraWindow(enough, baseline).ok).toBe(true);
    expect(defaultCameraWindowOptions.minCoverage).toBe(0.8);
  });

  it('labels a window that failed mostly from movement as motion', () => {
    const results = frames(10, (i) =>
      i < 5 ? ok(i) : i < 8 ? fail('motion') : fail('missing_points'),
    );
    expect(summarizeCameraWindow(results, baseline)).toMatchObject({ ok: false, reason: 'motion' });
  });

  it('drops the nose signal when the baseline or most frames lack it', () => {
    const noBaselineNose = valid(
      summarizeCameraWindow(
        frames(5, (i) => ok(i)),
        { r0: 0.4, h0: 0.5, n0: null },
      ),
    );
    expect(noBaselineNose.nChange).toBeNull();
    const fewNoses = valid(
      summarizeCameraWindow(
        frames(5, (i) => ok(i, 0.4, 0.5, i < 2 ? -0.2 : null)),
        baseline,
      ),
    );
    expect(fewNoses.nChange).toBeNull();
  });
});

const summary = (rChange: number, hChange: number, nChange: number | null = 0) =>
  ({ ok: true, rChange, hChange, nChange, coverage: 1, frames: 10 }) as const;

describe('judgeCameraChange', () => {
  it('is normal inside the thresholds', () => {
    expect(judgeCameraChange(summary(0.05, -0.05, -0.05))).toEqual({
      level: 'normal',
      type: null,
      forwardLevel: 'normal',
      dropLevel: 'normal',
    });
  });

  it('treats the threshold values themselves as reached', () => {
    const { forward, drop } = draftCameraChangeThresholds;
    expect(judgeCameraChange(summary(forward.caution, 0)).level).toBe('caution');
    expect(judgeCameraChange(summary(forward.high, 0)).level).toBe('high');
    expect(judgeCameraChange(summary(0, drop.caution)).level).toBe('caution');
    expect(judgeCameraChange(summary(0, drop.high)).level).toBe('high');
  });

  it('classifies chin_forward, head_down and combined', () => {
    expect(judgeCameraChange(summary(0.15, 0)).type).toBe('chin_forward');
    expect(judgeCameraChange(summary(0, -0.15)).type).toBe('head_down');
    expect(judgeCameraChange(summary(0, 0, -0.15)).type).toBe('head_down');
    expect(judgeCameraChange(summary(0.15, -0.15)).type).toBe('combined');
  });

  it('takes the worse of the two signals as the level', () => {
    const result = judgeCameraChange(summary(0.25, -0.12));
    expect(result).toMatchObject({ level: 'high', forwardLevel: 'high', dropLevel: 'caution' });
    expect(result.type).toBe('combined');
  });

  it('ignores the nose when it is unavailable', () => {
    expect(judgeCameraChange(summary(0, 0, null)).level).toBe('normal');
  });
});

describe('cameraObservation', () => {
  it('passes the medians on as change values', () => {
    expect(
      cameraObservation({
        ok: true,
        rChange: 0.2,
        hChange: -0.1,
        nChange: null,
        coverage: 1,
        frames: 10,
      }),
    ).toEqual({ cameraChange: { forward: 0.2, drop: -0.1, noseDrop: null } });
  });

  it('keeps the failure reason instead of a normal posture', () => {
    expect(cameraObservation({ ok: false, reason: 'motion', coverage: 0.4, frames: 10 })).toEqual({
      cameraChange: null,
      quality: 'motion',
    });
  });

  it('reads the draft thresholds from the policy', () => {
    expect(draftCameraChangeThresholds.forward).toEqual(policy.camera_change_thresholds.forward);
    expect(draftCameraChangeThresholds.noseDrop).toEqual(policy.camera_change_thresholds.nose_drop);
  });
});
