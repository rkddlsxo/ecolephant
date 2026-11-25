import { describe, expect, it } from 'vitest';
import {
  commonRoutine,
  recommendStretch,
  stretchCaution,
  stretches,
  stretchesForType,
} from './stretching';

describe('stretch recommendation (one common routine, 2026-11-21)', () => {
  it('uses the same routine for every posture type', () => {
    expect(commonRoutine).toEqual(['chin_tuck', 'neck_back_stretch', 'chest_opener']);
    for (const type of ['chin_forward', 'head_down', 'combined'] as const) {
      expect(recommendStretch(type)?.stretch.id).toBe('chin_tuck');
      expect(stretchesForType[type]).toBe(commonRoutine);
    }
    expect(Object.keys(stretches)).toHaveLength(3);
  });

  it('returns nothing when there is no posture to correct', () => {
    expect(recommendStretch(null)).toBeNull();
    expect(recommendStretch(null, { attempts: [], postureCounts: {} })).toBeNull();
    expect(recommendStretch(null, { attempts: [], postureCounts: { head_down: 0 } })).toBeNull();
  });

  it('still recommends when a posture was detected recently but not now', () => {
    const result = recommendStretch(null, { attempts: [], postureCounts: { head_down: 7 } });
    expect(result).toMatchObject({ reason: 'most_frequent_posture', stretch: { id: 'chin_tuck' } });
  });

  it('goes through the routine in order without repeating the last stretch', () => {
    const next = (id: (typeof commonRoutine)[number]) =>
      recommendStretch('combined', { attempts: [{ id, completed: true }] })?.stretch.id;
    expect(next('chin_tuck')).toBe('neck_back_stretch');
    expect(next('neck_back_stretch')).toBe('chest_opener');
    expect(next('chest_opener')).toBe('chin_tuck');
  });

  it('shortens the hold after an unfinished attempt, never below 3 s', () => {
    const eased = recommendStretch('head_down', {
      attempts: [
        { id: 'neck_back_stretch', completed: false, heldSeconds: 6 },
        { id: 'chin_tuck', completed: true },
      ],
    });
    expect(eased).toMatchObject({
      stretch: { id: 'neck_back_stretch' },
      eased: true,
      holdSeconds: 9,
    });
    const short = recommendStretch('chin_forward', {
      attempts: [
        { id: 'chin_tuck', completed: false, heldSeconds: 1 },
        { id: 'chest_opener', completed: true },
      ],
    });
    expect(short).toMatchObject({ stretch: { id: 'chin_tuck' }, eased: true, holdSeconds: 3 });
    expect(recommendStretch('head_down')).toMatchObject({ eased: false, holdSeconds: 5 });
  });

  it('always carries the caution and the screen-height tip', () => {
    for (const type of ['chin_forward', 'head_down', 'combined'] as const) {
      expect(recommendStretch(type)).toMatchObject({ caution: stretchCaution });
      expect(recommendStretch(type)?.tip).toMatch(/눈높이/);
    }
  });
});
