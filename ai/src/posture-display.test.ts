import { describe, expect, it } from 'vitest';
import { displayPostureLabel, displayPostureType } from './posture-display';

describe('shown posture type (2026-11-28)', () => {
  it('shows head down whenever the drop part reached caution', () => {
    expect(displayPostureType('head_down')).toBe('head_down');
    expect(displayPostureType('combined')).toBe('head_down');
    expect(displayPostureType('chin_forward')).toBe('chin_forward');
    expect(displayPostureType(null)).toBeNull();
    expect(displayPostureType(undefined)).toBeNull();
  });

  it('has a Korean label for each shown type', () => {
    expect(displayPostureLabel).toEqual({
      chin_forward: '고개 앞으로 쏠림',
      head_down: '고개 숙임',
    });
  });
});
