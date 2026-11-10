import type { CameraChange, Observation, Scenario } from './types';

/**
 * Demo-only conversion so the manual webcam slider (degrees) also drives change-based
 * policies. 15° ↔ +0.10 is an arbitrary display convenience, NOT a validated mapping.
 */
function demoChange(cameraDeg: number | null, drop = -0.02): CameraChange | null {
  return cameraDeg === null ? null : { forward: cameraDeg / 150, drop, noseDrop: null };
}

/** Synthetic signals only. These values are never inferred from a camera or headphones. */
export function demoObservation(
  scenario: Scenario,
  elapsedMs: number,
  manual: Observation,
): Observation {
  if (scenario === 'manual')
    return { ...manual, cameraChange: manual.cameraChange ?? demoChange(manual.cameraDeg) };
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
  const small = noise / 100;
  switch (selection) {
    case 'high':
      return {
        cameraDeg: 38 + noise,
        headDeg: 34 + noise,
        cameraChange: { forward: 0.26 + small, drop: -0.05 + small, noseDrop: null },
      };
    case 'head_down':
      return {
        cameraDeg: 8 + noise,
        headDeg: 38 + noise,
        cameraChange: { forward: 0.03 + small, drop: -0.24 + small, noseDrop: null },
      };
    case 'camera_lost':
      return { cameraDeg: null, headDeg: 12 + noise, cameraChange: null };
    case 'missing':
      return { cameraDeg: null, headDeg: null, cameraChange: null };
    case 'motion':
      return { cameraDeg: null, headDeg: null, cameraChange: null, quality: 'motion' };
    default:
      return {
        cameraDeg: 8 + noise,
        headDeg: 6 + noise,
        cameraChange: { forward: 0.03 + small, drop: -0.02 + small, noseDrop: null },
      };
  }
}
