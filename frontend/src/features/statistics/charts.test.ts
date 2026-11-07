import { expect, it } from 'vitest';
import { placeDirectLabels } from './charts';

const anchor = (key: string, y: number) => ({ key, name: key, color: '#000', x: 100, y });

it('keeps direct labels at their line end when they do not collide', () => {
  const placed = placeDirectLabels([anchor('a', 40), anchor('b', 120)], 16, 212);
  expect(placed.map((p) => p.labelY)).toEqual([40, 120]);
});

it('pushes labels apart when series end at nearly the same value', () => {
  const placed = placeDirectLabels([anchor('a', 100), anchor('b', 102), anchor('c', 101)], 16, 212);
  const ys = placed.map((p) => p.labelY);
  expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(15);
  expect(ys[2]! - ys[1]!).toBeGreaterThanOrEqual(15);
});

it('keeps pushed labels inside the plot at the bottom edge', () => {
  const placed = placeDirectLabels([anchor('a', 210), anchor('b', 211)], 16, 212);
  expect(Math.max(...placed.map((p) => p.labelY))).toBeLessThanOrEqual(212);
  expect(placed[1]!.labelY - placed[0]!.labelY).toBeGreaterThanOrEqual(15);
});
