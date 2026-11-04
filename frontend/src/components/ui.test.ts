import { describe, expect, it } from 'vitest';
import { formatDuration } from './ui';

describe('duration labels', () => {
  it('distinguishes a short nonzero interval from no time', () => {
    expect(formatDuration(0)).toBe('0분 0초');
    expect(formatDuration(1)).toBe('1초 미만');
    expect(formatDuration(999)).toBe('1초 미만');
    expect(formatDuration(1000)).toBe('0분 1초');
  });
});
