import { describe, expect, it } from 'vitest';
import { headFlexionDeg } from './head-motion';

const rad = (deg: number) => (deg * Math.PI) / 180;

describe('head flexion normalization', () => {
  it('converts the pitch difference from the baseline to degrees', () => {
    const result = headFlexionDeg(rad(25), rad(5));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.deg).toBeCloseTo(20, 9);
  });

  it('normalizes tilting back from the baseline to 0 (not invalid)', () => {
    expect(headFlexionDeg(rad(-10), rad(0))).toEqual({ ok: true, deg: 0 });
  });

  it('applies the device sign before normalizing', () => {
    const flipped = headFlexionDeg(rad(-20), rad(0), -1);
    expect(flipped.ok && flipped.deg).toBeCloseTo(20, 9);
    expect(headFlexionDeg(rad(20), rad(0), -1)).toEqual({ ok: true, deg: 0 });
  });

  it('keeps 90 degrees valid and reports larger values instead of clamping', () => {
    const edge = headFlexionDeg(rad(90), 0);
    expect(edge.ok && edge.deg).toBeCloseTo(90, 9);
    expect(headFlexionDeg(rad(91), 0)).toEqual({ ok: false, reason: 'out_of_range' });
  });

  it('rejects non-finite input', () => {
    expect(headFlexionDeg(Number.NaN, 0)).toEqual({ ok: false, reason: 'invalid_input' });
    expect(headFlexionDeg(0, Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
  });
});
