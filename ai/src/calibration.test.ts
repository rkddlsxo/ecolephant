import { describe, expect, it } from 'vitest';
import {
  advanceCalibration,
  draftCalibrationOptions,
  initialCalibration,
  median,
  type CalibrationState,
} from './calibration';
import type { FeatureResult } from './camera-features';

const ok = (timestampMs: number, r = 0.33, h = 0.5): FeatureResult => ({
  ok: true,
  features: { timestampMs, r, h },
});

/** Feeds frames every `step` ms from `start` until `end` (inclusive). */
function feed(
  state: CalibrationState,
  start: number,
  end: number,
  step = 70,
  make: (t: number) => FeatureResult = (t) => ok(t),
) {
  for (let t = start; t <= end; t += step) state = advanceCalibration(state, make(t));
  return state;
}

describe('calibration', () => {
  it('finishes after 3 s of stable frames and stores the median', () => {
    let state = initialCalibration();
    // small alternating jitter around r=0.33, h=0.5
    state = feed(state, 0, 2900, 100, (t) => ok(t, 0.33 + ((t / 100) % 2 ? 0.004 : -0.002), 0.5));
    expect(state.status).toBe('collecting');
    if (state.status === 'collecting') expect(state.progress).toBeCloseTo(2900 / 3000, 3);
    state = advanceCalibration(state, ok(3000, 0.33, 0.5));
    expect(state.status).toBe('done');
    if (state.status !== 'done') return;
    // 15 samples at 0.334, 15 at 0.328, final 0.33 → median 0.33
    expect(state.baseline.r0).toBeCloseTo(0.33, 6);
    expect(state.baseline.h0).toBe(0.5);
    expect(state.baseline).toMatchObject({ samples: 31, startedMs: 0, endedMs: 3000 });
  });

  it('treats exactly the stable duration as enough', () => {
    const state = feed(initialCalibration(), 0, draftCalibrationOptions.stableDurationMs, 100);
    expect(state.status).toBe('done');
  });

  it('restarts on a bad frame and reports why', () => {
    let state = feed(initialCalibration(), 0, 2000);
    state = advanceCalibration(state, { ok: false, reason: 'motion' });
    expect(state).toMatchObject({
      status: 'collecting',
      samples: [],
      lastRestart: 'motion',
      restarts: 1,
    });
    state = feed(state, 2100, 4000);
    expect(state.status).toBe('collecting'); // needs a fresh full 3 s
    state = feed(state, 4070, 5200);
    expect(state.status).toBe('done');
  });

  it('restarts from the current frame when the posture jumps', () => {
    let state = feed(initialCalibration(), 0, 1500);
    state = advanceCalibration(state, ok(1570, 0.4)); // r +21%
    expect(state).toMatchObject({ status: 'collecting', lastRestart: 'unstable' });
    if (state.status === 'collecting') expect(state.samples).toHaveLength(1);
    state = feed(state, 1640, 4600, 70, (t) => ok(t, 0.4)); // last frame 4580 ≥ 1570 + 3000
    expect(state.status).toBe('done');
    if (state.status === 'done') expect(state.baseline.r0).toBeCloseTo(0.4, 6);
  });

  it('restarts on a gap longer than the max sample age', () => {
    let state = feed(initialCalibration(), 0, 1000);
    state = advanceCalibration(state, ok(1000 + draftCalibrationOptions.maxGapMs + 1));
    expect(state).toMatchObject({ status: 'collecting', lastRestart: 'gap' });
  });

  it('rejects non-increasing timestamps', () => {
    let state = feed(initialCalibration(), 0, 500); // last frame at 490
    state = advanceCalibration(state, ok(490));
    expect(state).toMatchObject({
      status: 'collecting',
      samples: [],
      lastRestart: 'time_reversed',
    });
  });

  it('needs a minimum number of samples even over 3 s', () => {
    // 400 ms steps stay within the gap limit but give only 8 samples in 3 s
    const state = feed(initialCalibration(), 0, 2800, 400);
    expect(state.status).toBe('collecting');
  });

  it('does not count restarts before any sample was collected', () => {
    let state = initialCalibration();
    state = advanceCalibration(state, { ok: false, reason: 'no_pose' });
    state = advanceCalibration(state, { ok: false, reason: 'no_pose' });
    expect(state).toMatchObject({ restarts: 0, lastRestart: 'no_pose' });
  });

  it('ignores further frames once done', () => {
    const done = feed(initialCalibration(), 0, 3000, 100);
    expect(advanceCalibration(done, { ok: false, reason: 'motion' })).toBe(done);
  });

  it('computes medians for odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('stores the nose baseline only when at least half of the segment had a nose', () => {
    const withNose = feed(initialCalibration(), 0, 3000, 100, (t) => ({
      ok: true,
      features: { timestampMs: t, r: 0.33, h: 0.5, n: -0.2 },
    }));
    expect(withNose.status === 'done' && withNose.baseline.n0).toBeCloseTo(-0.2, 6);
    const mostlyMissing = feed(initialCalibration(), 0, 3000, 100, (t) => ({
      ok: true,
      features: { timestampMs: t, r: 0.33, h: 0.5, n: t < 1000 ? -0.2 : null },
    }));
    expect(mostlyMissing.status === 'done' && mostlyMissing.baseline.n0).toBeNull();
  });
});
