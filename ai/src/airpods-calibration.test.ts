import { describe, expect, it } from 'vitest';
import {
  advancePitchCalibration,
  advanceWearCheck,
  initialPitchCalibration,
  type PitchCalibrationState,
} from './airpods-calibration';
import { headFlexionDeg } from './head-motion';

const rad = (deg: number) => (deg * Math.PI) / 180;

function feed(samples: Array<[number, number]>, state = initialPitchCalibration()) {
  let s: PitchCalibrationState = state;
  for (const [t, deg] of samples) s = advancePitchCalibration(s, { t, pitchRad: rad(deg) });
  return s;
}

const steady = (start: number, deg: number, count = 31, step = 100) =>
  Array.from(
    { length: count },
    (_, i) => [start + i * step, deg + (i % 2 ? 0.5 : -0.5)] as [number, number],
  );

describe('AirPods wearing-angle calibration', () => {
  it('stores the median pitch of a steady 3 s segment', () => {
    const result = feed(steady(0, 12));
    expect(result.status).toBe('done');
    if (result.status !== 'done') return;
    // Samples alternate 11.5° / 12.5°; the median is one of them.
    expect(Math.abs((result.baselineRad * 180) / Math.PI - 12)).toBeLessThan(0.51);
    // Flexion is measured from this wearing's own baseline.
    const flexion = headFlexionDeg(rad(32), result.baselineRad);
    expect(flexion.ok && Math.abs(flexion.deg - 20)).toBeLessThan(0.51);
  });

  it('reports progress while collecting', () => {
    const half = feed(steady(0, 5, 16));
    expect(half).toMatchObject({ status: 'collecting', lastRestart: null });
    if (half.status === 'collecting') expect(half.progress).toBeCloseTo(0.5, 1);
  });

  it('restarts on movement, gaps, invalid and reversed time', () => {
    expect(feed([...steady(0, 0, 10), [1000, 10]])).toMatchObject({ lastRestart: 'unstable' });
    expect(feed([...steady(0, 0, 10), [2000, 0]])).toMatchObject({ lastRestart: 'gap' });
    expect(
      feed([
        [0, 0],
        [100, Number.NaN],
      ]),
    ).toMatchObject({ lastRestart: 'invalid' });
    expect(
      feed([
        [100, 0],
        [50, 0],
      ]),
    ).toMatchObject({ lastRestart: 'time_reversed' });
  });

  it('can finish after a restart', () => {
    const restarted = feed([...steady(0, 0, 10), [1000, 10]]);
    expect(feed(steady(1100, 10), restarted).status).toBe('done');
  });

  it('keeps the baseline once done', () => {
    const done = feed(steady(0, 3));
    expect(advancePitchCalibration(done, { t: 99_999, pitchRad: rad(40) })).toBe(done);
  });
});

describe('wearing shift check', () => {
  it('suspects a moved earbud after 30 s of disagreement with the webcam', () => {
    let state = { since: null as number | null };
    let suspect = false;
    for (let t = 0; t <= 30_000; t += 1000) {
      ({ state, suspect } = advanceWearCheck(state, {
        t,
        cameraDropLevel: 'normal',
        headFlexionDeg: 20,
      }));
      if (t < 30_000) expect(suspect).toBe(false);
    }
    expect(suspect).toBe(true);
  });

  it('starts over when the webcam agrees or data is missing', () => {
    const base = { state: { since: 0 } };
    expect(
      advanceWearCheck(base.state, { t: 40_000, cameraDropLevel: 'caution', headFlexionDeg: 20 }),
    ).toEqual({ state: { since: null }, suspect: false });
    expect(
      advanceWearCheck(base.state, { t: 40_000, cameraDropLevel: null, headFlexionDeg: 20 }),
    ).toEqual({ state: { since: null }, suspect: false });
    expect(
      advanceWearCheck(base.state, { t: 40_000, cameraDropLevel: 'normal', headFlexionDeg: 5 }),
    ).toEqual({ state: { since: null }, suspect: false });
  });
});
