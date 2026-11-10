import policy from './policy.json';
import { levelAbove, levelBelow, postureTypeOf, worst } from './camera-window';
import type { CameraLevel } from './camera-window';
import type { CameraChange, DerivedWindow, Mode, Observation, Reason, Level } from './types';

interface Band {
  caution: number;
  high: number;
}

/** The parts of a policy that decide a window. Old sessions use the angle policy (draft-web-v0). */
export interface DecisionPolicy {
  thresholds_deg: Band;
  /** "angle" (draft-web-v0, default when missing) or "change" (draft-web-v1, DEC-002). */
  camera_judgement?: string;
  camera_change_thresholds?: { forward: Band; drop: Band; nose_drop: Band };
}

function usable(value: number | null) {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 90;
}

function usableChange(change: CameraChange | null | undefined): change is CameraChange {
  return (
    !!change &&
    Number.isFinite(change.forward) &&
    Number.isFinite(change.drop) &&
    (change.noseDrop === null || Number.isFinite(change.noseDrop))
  );
}

function changeReason(level: Level, type: DerivedWindow['posture_type']): Reason {
  // Same level/reason pairs as the angle table, so statistics and the harness keep their meaning.
  // The posture type carries the detail (chin forward vs head down).
  if (level === 'normal') return 'within_range';
  if (level === 'caution') return type === 'head_down' ? 'head_flexion' : 'mixed_caution';
  return type === 'chin_forward'
    ? 'forward_shift'
    : type === 'head_down'
      ? 'head_flexion'
      : 'combined_high';
}

export function deriveWindow(
  mode: Mode,
  observation: Observation,
  timing: Pick<DerivedWindow, 'seq' | 'elapsed_start_ms' | 'duration_ms' | 'calibration_epoch'>,
  activePolicy: DecisionPolicy = policy,
): DerivedWindow {
  const changeMode = activePolicy.camera_judgement === 'change';
  const cameraChange =
    changeMode && mode !== 'airpods' && usableChange(observation.cameraChange)
      ? observation.cameraChange
      : null;
  const cameraDeg =
    !changeMode && mode !== 'airpods' && usable(observation.cameraDeg)
      ? observation.cameraDeg
      : null;
  const hasCamera = changeMode ? cameraChange !== null : cameraDeg !== null;
  const head = mode !== 'webcam' && usable(observation.headDeg) ? observation.headDeg : null;
  const active =
    hasCamera && head !== null
      ? 'combined'
      : hasCamera
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
    camera_forward_change: null,
    camera_drop_change: null,
    camera_nose_drop_change: null,
    posture_type: null,
  };
  if (invalid) return base;
  const confidence = active === 'combined' ? 'dual_sensor' : 'single_sensor';
  if (changeMode) return changeWindow(base, cameraChange, head, activePolicy, confidence);
  const camera = cameraDeg;
  const display = active === 'combined' ? (camera! + head!) / 2 : (camera ?? head)!;
  const { caution, high } = activePolicy.thresholds_deg;
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
    confidence,
  };
}

/**
 * Change-based judgement (draft-web-v1). Each sensor judges what it measures best:
 * the webcam judges the forward shift; the head drop comes from AirPods when connected,
 * otherwise from the webcam ear/nose height. The level is the worse of the two parts.
 * No webcam degrees are produced until the side-view experiment validates a mapping.
 */
function changeWindow(
  base: DerivedWindow,
  camera: CameraChange | null,
  head: number | null,
  activePolicy: DecisionPolicy,
  confidence: DerivedWindow['confidence'],
): DerivedWindow {
  const bands = activePolicy.camera_change_thresholds;
  if (!bands) throw new Error('Change-based policy needs camera_change_thresholds');
  const forwardLevel: CameraLevel = camera ? levelAbove(camera.forward, bands.forward) : 'normal';
  const dropLevel: CameraLevel =
    head !== null
      ? levelAbove(head, activePolicy.thresholds_deg)
      : camera
        ? worst(
            levelBelow(camera.drop, bands.drop),
            camera.noseDrop === null ? 'normal' : levelBelow(camera.noseDrop, bands.nose_drop),
          )
        : 'normal';
  const level = worst(forwardLevel, dropLevel);
  const type = postureTypeOf(forwardLevel, dropLevel);
  return {
    ...base,
    head_flexion_deg: head,
    // Only measured degrees are shown: the AirPods angle when present, never a webcam guess.
    display_angle_deg: head,
    posture_level: level,
    reason_code: changeReason(level, type),
    confidence,
    camera_forward_change: camera?.forward ?? null,
    camera_drop_change: camera?.drop ?? null,
    camera_nose_drop_change: camera?.noseDrop ?? null,
    posture_type: type,
  };
}
