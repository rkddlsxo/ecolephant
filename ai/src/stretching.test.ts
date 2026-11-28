import { describe, expect, it } from 'vitest';
import { recommendStretch, stretchCaution, stretches, stretchesForType } from './stretching';

describe('stretch recommendation by shown posture type (2026-11-28)', () => {
  it('chin tuck for head forward; neck back stretch then chest opener for head down', () => {
    expect(stretchesForType.chin_forward).toEqual(['chin_tuck']);
    expect(stretchesForType.head_down).toEqual(['neck_back_stretch', 'chest_opener']);
    // The front camera cannot tell "combined" from a large head drop, so it is shown as head down.
    expect(stretchesForType.combined).toEqual(stretchesForType.head_down);
    expect(recommendStretch('chin_forward')?.stretch.id).toBe('chin_tuck');
    expect(recommendStretch('head_down')?.stretch.id).toBe('neck_back_stretch');
    expect(recommendStretch('combined')?.stretch.id).toBe('neck_back_stretch');
    expect(Object.keys(stretches)).toHaveLength(3);
  });

  it('returns nothing when there is no posture to correct', () => {
    expect(recommendStretch(null)).toBeNull();
    expect(recommendStretch(null, { attempts: [], postureCounts: {} })).toBeNull();
    expect(recommendStretch(null, { attempts: [], postureCounts: { head_down: 0 } })).toBeNull();
  });

  it('uses the most frequent shown type when nothing is detected now (combined counts as head down)', () => {
    const forward = recommendStretch(null, {
      attempts: [],
      postureCounts: { chin_forward: 5, head_down: 2 },
    });
    expect(forward).toMatchObject({
      reason: 'most_frequent_posture',
      stretch: { id: 'chin_tuck' },
    });
    const down = recommendStretch(null, {
      attempts: [],
      postureCounts: { chin_forward: 5, head_down: 2, combined: 4 },
    });
    expect(down?.stretch.id).toBe('neck_back_stretch');
  });

  it('does not repeat the last stretch when the type has another one', () => {
    const after = (id: 'neck_back_stretch' | 'chest_opener') =>
      recommendStretch('head_down', { attempts: [{ id, completed: true }] })?.stretch.id;
    expect(after('neck_back_stretch')).toBe('chest_opener');
    expect(after('chest_opener')).toBe('neck_back_stretch');
    expect(
      recommendStretch('chin_forward', { attempts: [{ id: 'chin_tuck', completed: true }] })
        ?.stretch.id,
    ).toBe('chin_tuck');
  });

  it('shortens the hold after an unfinished attempt, never below 3 s', () => {
    const eased = recommendStretch('head_down', {
      attempts: [
        { id: 'neck_back_stretch', completed: false, heldSeconds: 6 },
        { id: 'chest_opener', completed: true },
      ],
    });
    expect(eased).toMatchObject({
      stretch: { id: 'neck_back_stretch' },
      eased: true,
      holdSeconds: 9,
    });
    const short = recommendStretch('chin_forward', {
      attempts: [{ id: 'chin_tuck', completed: false, heldSeconds: 1 }],
    });
    expect(short).toMatchObject({ stretch: { id: 'chin_tuck' }, eased: true, holdSeconds: 3 });
    expect(recommendStretch('chin_forward')).toMatchObject({ eased: false, holdSeconds: 5 });
  });

  it('always carries the caution; the screen-height tip only for head down', () => {
    for (const type of ['chin_forward', 'head_down', 'combined'] as const)
      expect(recommendStretch(type)).toMatchObject({ caution: stretchCaution });
    expect(recommendStretch('head_down')?.tip).toMatch(/눈높이/);
    expect(recommendStretch('combined')?.tip).toMatch(/눈높이/);
    expect(recommendStretch('chin_forward')?.tip).toBeNull();
  });
});
