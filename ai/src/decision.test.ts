import { describe, expect, it } from 'vitest';
import { deriveWindow } from './decision';
import type { Mode, Observation } from './types';

const timing = { seq: 1, elapsed_start_ms: 0, duration_ms: 1000, calibration_epoch: 1 };
const run = (mode: Mode, observation: Observation) => deriveWindow(mode, observation, timing);
const combined = (cameraDeg: number, headDeg: number) => run('combined', { cameraDeg, headDeg });

/**
 * docs/measurement/decision-rules.md. Bands: 0 ≤ x < 15, 15 ≤ x < 30, 30 ≤ x ≤ 90.
 * These tests pin the current draft profile; they do not validate it clinically (DEC-004).
 */
describe('combined decision table', () => {
  it.each([
    // camera, head, level, reason, source in the doc table
    [35, 35, 'high', 'combined_high'], // 원문
    [35, 5, 'high', 'forward_shift'], // 원문
    [5, 35, 'caution', 'head_flexion'], // 원문
    [5, 5, 'normal', 'within_range'], // 설계 제안
    [35, 20, 'high', 'forward_shift'], // 설계 제안
    [20, 5, 'caution', 'mixed_caution'], // 설계 제안
    [20, 35, 'caution', 'mixed_caution'], // 설계 제안 (DEC-004: display 27.5 but caution)
    [5, 20, 'caution', 'mixed_caution'], // 설계 제안
  ] as const)('camera %d°, head %d° → %s / %s', (camera, head, level, reason) => {
    const result = combined(camera, head);
    expect(result).toMatchObject({
      posture_level: level,
      reason_code: reason,
      active_mode: 'combined',
      confidence: 'dual_sensor',
      quality: 'valid',
    });
  });

  it('includes the lower bound of each band', () => {
    expect(combined(15, 0)).toMatchObject({ posture_level: 'caution' });
    expect(combined(14.999, 14.999)).toMatchObject({ posture_level: 'normal' });
    expect(combined(30, 0)).toMatchObject({ posture_level: 'high', reason_code: 'forward_shift' });
    expect(combined(30, 30)).toMatchObject({ reason_code: 'combined_high' });
    expect(combined(29.999, 0)).toMatchObject({ posture_level: 'caution' });
    expect(combined(0, 30)).toMatchObject({
      posture_level: 'caution',
      reason_code: 'head_flexion',
    });
    expect(combined(0, 29.999)).toMatchObject({ reason_code: 'mixed_caution' });
  });

  it('shows the reference value without letting it decide the level', () => {
    // decision-rules.md example: 40° + 5° → 22.5° reference, but high / forward_shift
    expect(combined(40, 5)).toMatchObject({
      display_angle_deg: 22.5,
      posture_level: 'high',
      reason_code: 'forward_shift',
      camera_estimate_deg: 40,
      head_flexion_deg: 5,
    });
  });
});

describe('single sensor', () => {
  it.each([
    [10, 'normal', 'within_range'],
    [15, 'caution', 'mixed_caution'],
    [30, 'high', 'forward_shift'],
  ] as const)('webcam only %d° → %s / %s', (deg, level, reason) => {
    expect(run('webcam', { cameraDeg: deg, headDeg: 50 })).toMatchObject({
      active_mode: 'webcam',
      posture_level: level,
      reason_code: reason,
      head_flexion_deg: null, // AirPods value is ignored in webcam mode
      display_angle_deg: deg,
      confidence: 'single_sensor',
    });
  });

  it.each([
    [10, 'normal', 'within_range'],
    [15, 'caution', 'head_flexion'],
    [30, 'high', 'head_flexion'],
  ] as const)('AirPods only %d° → %s / %s', (deg, level, reason) => {
    expect(run('airpods', { cameraDeg: 50, headDeg: deg })).toMatchObject({
      active_mode: 'airpods',
      posture_level: level,
      reason_code: reason,
      camera_estimate_deg: null,
    });
  });

  it('falls back to the remaining sensor in combined mode', () => {
    expect(run('combined', { cameraDeg: null, headDeg: 20 })).toMatchObject({
      active_mode: 'airpods',
      posture_level: 'caution',
      reason_code: 'head_flexion',
      confidence: 'single_sensor',
    });
  });
});

describe('invalid input is never treated as normal', () => {
  const unknown = {
    posture_level: 'unknown',
    confidence: 'unavailable',
    camera_estimate_deg: null,
    head_flexion_deg: null,
    display_angle_deg: null,
  };

  it('reports no_sensor when nothing is usable, without filling 0°', () => {
    expect(run('combined', { cameraDeg: null, headDeg: null })).toMatchObject({
      ...unknown,
      quality: 'no_sensor',
      active_mode: 'none',
      reason_code: 'insufficient_data',
    });
  });

  it.each([
    ['negative', -0.1],
    ['above 90', 90.1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('drops a %s angle as out of contract range', (_label, value) => {
    expect(run('webcam', { cameraDeg: value, headDeg: null })).toMatchObject({
      ...unknown,
      quality: 'no_sensor',
    });
    // the other sensor still decides
    expect(run('combined', { cameraDeg: 5, headDeg: value })).toMatchObject({
      active_mode: 'webcam',
      posture_level: 'normal',
    });
  });

  it('keeps 0° and 90° as valid edges', () => {
    expect(run('webcam', { cameraDeg: 0, headDeg: null })).toMatchObject({
      posture_level: 'normal',
    });
    expect(run('webcam', { cameraDeg: 90, headDeg: null })).toMatchObject({
      posture_level: 'high',
    });
  });

  it.each(['motion', 'calibrating', 'paused'] as const)(
    'passes %s through as the reason with unknown level',
    (quality) => {
      expect(run('combined', { cameraDeg: 40, headDeg: 40, quality })).toMatchObject({
        ...unknown,
        quality,
        reason_code: quality,
        active_mode: 'combined',
      });
    },
  );

  it('maps low_confidence to insufficient_data', () => {
    expect(
      run('webcam', { cameraDeg: 40, headDeg: null, quality: 'low_confidence' }),
    ).toMatchObject({ ...unknown, reason_code: 'insufficient_data' });
  });

  it('copies window timing unchanged', () => {
    expect(run('webcam', { cameraDeg: 5, headDeg: null })).toMatchObject(timing);
  });
});
