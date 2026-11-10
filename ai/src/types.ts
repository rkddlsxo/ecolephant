export type Mode = 'webcam' | 'airpods' | 'combined';
export type ActiveMode = Mode | 'none';
export type Quality =
  'valid' | 'no_sensor' | 'low_confidence' | 'motion' | 'calibrating' | 'paused';
export type Level = 'normal' | 'caution' | 'high' | 'unknown';
export type Reason =
  | 'within_range'
  | 'combined_high'
  | 'forward_shift'
  | 'head_flexion'
  | 'mixed_caution'
  | 'insufficient_data'
  | 'motion'
  | 'calibrating'
  | 'paused';
/**
 * Posture type (team-agreed MVP set, 2026-11-10): chin_forward = head pushed toward the
 * screen without dropping, head_down = head dropped without moving forward, combined = both.
 * Rounded shoulders and cervical straightening are out of scope.
 */
export type PostureType = 'chin_forward' | 'head_down' | 'combined';
/** Webcam change against the personal baseline (dimensionless, not degrees). */
export interface CameraChange {
  /** rChange = r/r0 - 1. Positive: head closer to the camera. */
  forward: number;
  /** hChange = h - h0. Negative: ears dropped toward the shoulders. */
  drop: number;
  /** nChange = n - n0. Negative: nose dropped relative to the ears. `null` if unreliable. */
  noseDrop: number | null;
}
export interface Observation {
  /** Webcam angle. Only used by policies whose camera_judgement is "angle" (validated mapping). */
  cameraDeg: number | null;
  headDeg: number | null;
  /** Webcam change. Used by policies whose camera_judgement is "change" (draft-web-v1). */
  cameraChange?: CameraChange | null;
  quality?: Exclude<Quality, 'valid'>;
}
export interface DerivedWindow {
  seq: number;
  elapsed_start_ms: number;
  duration_ms: number;
  calibration_epoch: number;
  active_mode: ActiveMode;
  quality: Quality;
  camera_estimate_deg: number | null;
  head_flexion_deg: number | null;
  display_angle_deg: number | null;
  posture_level: Level;
  reason_code: Reason;
  confidence: 'dual_sensor' | 'single_sensor' | 'unavailable';
  /** Webcam change values behind the judgement (derived numbers, never landmarks). */
  camera_forward_change: number | null;
  camera_drop_change: number | null;
  camera_nose_drop_change: number | null;
  posture_type: PostureType | null;
}
export type Scenario =
  'auto' | 'normal' | 'high' | 'head_down' | 'camera_lost' | 'missing' | 'motion' | 'manual';
