import { describe, expect, it } from 'vitest';
import { defaultGuide } from '@ecolephant/ai';
import { silhouettePaths } from './GuideSilhouette';

describe('guide silhouette', () => {
  it('places the head and shoulders inside the defaultGuide ranges', () => {
    const width = 1280;
    const height = 720;
    const { head, body } = silhouettePaths(width, height);
    expect(head.cx / width).toBeCloseTo(defaultGuide.centerX);
    expect(head.cy / height).toBeGreaterThan(defaultGuide.earY.min);
    expect(head.cy / height).toBeLessThan(defaultGuide.earY.max);

    const points = [...body.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    // Outer shoulder corners: the points where each curve ends.
    const corners = points.filter(([, y]) => y < height && y > head.cy + head.ry);
    const xs = corners.map(([x]) => x);
    const span = (Math.max(...xs) - Math.min(...xs)) / width;
    expect(span).toBeGreaterThan(defaultGuide.shoulderWidth.min);
    expect(span).toBeLessThan(defaultGuide.shoulderWidth.max + 0.05);
    const shoulderY = Math.max(...corners.map(([, y]) => y)) / height;
    expect(shoulderY).toBeGreaterThan(defaultGuide.shoulderY.min);
    expect(shoulderY).toBeLessThan(defaultGuide.shoulderY.max);
  });
});
