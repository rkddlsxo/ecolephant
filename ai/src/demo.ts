import type { Observation, Scenario } from './types';

/** Synthetic signals only. These values are never inferred from a camera or headphones. */
export function demoObservation(
  scenario: Scenario,
  elapsedMs: number,
  manual: Observation,
): Observation {
  if (scenario === 'manual') return manual;
  const seconds = elapsedMs / 1000;
  const selection =
    scenario === 'auto'
      ? seconds % 100 < 15
        ? 'normal'
        : seconds % 100 < 75
          ? 'high'
          : seconds % 100 < 90
            ? 'normal'
            : 'missing'
      : scenario;
  const noise = Math.sin(seconds * 0.7) * 1.4;
  switch (selection) {
    case 'high':
      return { cameraDeg: 38 + noise, headDeg: 34 + noise };
    case 'head_down':
      return { cameraDeg: 8 + noise, headDeg: 38 + noise };
    case 'camera_lost':
      return { cameraDeg: null, headDeg: 12 + noise };
    case 'missing':
      return { cameraDeg: null, headDeg: null };
    case 'motion':
      return { cameraDeg: null, headDeg: null, quality: 'motion' };
    default:
      return { cameraDeg: 8 + noise, headDeg: 6 + noise };
  }
}
