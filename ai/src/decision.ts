import policy from './policy.json';
import type { DerivedWindow, Mode, Observation, Reason, Level } from './types';

function usable(value: number | null) {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 90;
}

export function deriveWindow(
  mode: Mode,
  observation: Observation,
  timing: Pick<DerivedWindow, 'seq' | 'elapsed_start_ms' | 'duration_ms' | 'calibration_epoch'>,
): DerivedWindow {
  const camera = mode !== 'airpods' && usable(observation.cameraDeg) ? observation.cameraDeg : null;
  const head = mode !== 'webcam' && usable(observation.headDeg) ? observation.headDeg : null;
  const active =
    camera !== null && head !== null
      ? 'combined'
      : camera !== null
        ? 'webcam'
        : head !== null
          ? 'airpods'
          : 'none';
  const quality = observation.quality ?? (active === 'none' ? 'no_sensor' : 'valid');
  const invalid = quality !== 'valid';
  const activeMode = invalid ? (quality === 'no_sensor' ? 'none' : mode) : active;
  const base: DerivedWindow = {
    ...timing,
    active_mode: activeMode,
    quality,
    camera_estimate_deg: null,
    head_flexion_deg: null,
    display_angle_deg: null,
    posture_level: 'unknown',
    reason_code:
      quality === 'no_sensor' || quality === 'low_confidence'
        ? 'insufficient_data'
        : quality === 'valid'
          ? 'insufficient_data'
          : quality,
    confidence: 'unavailable',
  };
  if (invalid) return base;
  const display = active === 'combined' ? (camera! + head!) / 2 : (camera ?? head)!;
  const { caution, high } = policy.thresholds_deg;
  let level: Level, reason: Reason;
  if (active !== 'combined') {
    level = display >= high ? 'high' : display >= caution ? 'caution' : 'normal';
    reason =
      level === 'normal'
        ? 'within_range'
        : active === 'airpods'
          ? 'head_flexion'
          : level === 'high'
            ? 'forward_shift'
            : 'mixed_caution';
  } else if (camera! >= high) {
    level = 'high';
    reason = head! >= high ? 'combined_high' : 'forward_shift';
  } else if (camera! < caution && head! < caution) {
    level = 'normal';
    reason = 'within_range';
  } else {
    level = 'caution';
    reason = camera! < caution && head! >= high ? 'head_flexion' : 'mixed_caution';
  }
  return {
    ...base,
    camera_estimate_deg: camera,
    head_flexion_deg: head,
    display_angle_deg: display,
    posture_level: level,
    reason_code: reason,
    confidence: active === 'combined' ? 'dual_sensor' : 'single_sensor',
  };
}
