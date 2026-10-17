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
export interface Observation {
  cameraDeg: number | null;
  headDeg: number | null;
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
}
export type Scenario =
  'auto' | 'normal' | 'high' | 'head_down' | 'camera_lost' | 'missing' | 'motion' | 'manual';
