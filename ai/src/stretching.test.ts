import { describe, expect, it } from 'vitest';
import { recommendStretch, stretchCaution, stretches, stretchesForType } from './stretching';

describe('stretch recommendation', () => {
  it('maps each posture type to the agreed stretches', () => {
    expect(recommendStretch('chin_forward')?.stretch.id).toBe('chin_tuck');
    expect(recommendStretch('head_down')?.stretch.id).toBe('neck_back_stretch');
    expect(recommendStretch('combined')?.stretch.id).toBe('chin_tuck');
    expect(Object.keys(stretches)).toHaveLength(3);
    expect(stretchesForType.combined).toEqual(['chin_tuck', 'chest_opener']);
  });

  it('returns nothing when there is no posture to correct', () => {
    expect(recommendStretch(null)).toBeNull();
    expect(recommendStretch(null, { attempts: [], postureCounts: {} })).toBeNull();
  });

  it('falls back to the most frequent posture type in the history', () => {
    const result = recommendStretch(null, {
      attempts: [],
      postureCounts: { chin_forward: 3, head_down: 7 },
    });
    expect(result).toMatchObject({
      reason: 'most_frequent_posture',
      stretch: { id: 'neck_back_stretch' },
    });
  });

  it('does not repeat the last stretch when another one fits', () => {
    const result = recommendStretch('combined', {
      attempts: [{ id: 'chin_tuck', completed: true }],
    });
    expect(result?.stretch.id).toBe('chest_opener');
    // Only one stretch fits: it is repeated rather than giving nothing.
    expect(
      recommendStretch('chin_forward', { attempts: [{ id: 'chin_tuck', completed: true }] })
        ?.stretch.id,
    ).toBe('chin_tuck');
  });

  it('shortens the hold after an unfinished attempt, never below 3 s', () => {
    const eased = recommendStretch('head_down', {
      attempts: [{ id: 'neck_back_stretch', completed: false, heldSeconds: 6 }],
    });
    expect(eased).toMatchObject({ eased: true, holdSeconds: 9 });
    const short = recommendStretch('chin_forward', {
      attempts: [{ id: 'chin_tuck', completed: false, heldSeconds: 1 }],
    });
    expect(short).toMatchObject({ eased: true, holdSeconds: 3 });
    expect(recommendStretch('head_down')).toMatchObject({ eased: false, holdSeconds: 15 });
  });

  it('always carries the caution and a screen tip for head drop', () => {
    expect(recommendStretch('chin_forward')).toMatchObject({ caution: stretchCaution, tip: null });
    expect(recommendStretch('head_down')?.tip).toMatch(/눈높이/);
  });
});
