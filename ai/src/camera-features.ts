import policy from './policy.json';

/**
 * Camera frame as produced by the frontend pose adapter (cameraModelResultSchema).
 * Coordinates are normalized 0..1 in the original (unmirrored) frame and stay on the device.
 */
export type CameraQuality = 'valid' | 'no_pose' | 'low_confidence' | 'motion';
export interface CameraPoint {
  x: number;
  y: number;
  confidence: number;
}
export interface CameraFrame {
  timestampMs: number;
  frameWidth: number;
  frameHeight: number;
  quality: CameraQuality;
  landmarks: {
    nose: CameraPoint | null;
    leftEar: CameraPoint | null;
    rightEar: CameraPoint | null;
    leftShoulder: CameraPoint | null;
    rightShoulder: CameraPoint | null;
  };
}

/**
 * Dimensionless local features (docs/measurement/signal-pipeline.md). These are NOT degrees,
 * CVA or neck angles; mapping them to degrees waits for DEC-002 validation.
 */
export interface CameraFeatures {
  timestampMs: number;
  /** face_width / shoulder_width, both in pixels. */
  r: number;
  /** (mid_shoulder_y - mid_ear_y) / shoulder_width, in pixels; larger = ears higher. */
  h: number;
  /**
   * (mid_ear_y - nose_y) / shoulder_width, in pixels; larger = nose higher relative to the ears.
   * A dropping head tends to lower it. `null` when the nose is missing or below the confidence
   * minimum; the frame is still usable for `r` and `h`.
   */
  n?: number | null;
}

export type FeatureFailure =
  'no_pose' | 'low_confidence' | 'motion' | 'missing_points' | 'degenerate';
export type FeatureResult =
  { ok: true; features: CameraFeatures } | { ok: false; reason: FeatureFailure };

export interface FeatureOptions {
  minConfidence: number;
  /** Shoulder width below this fraction of the frame diagonal is treated as unusable. */
  minShoulderFraction: number;
}

export const defaultFeatureOptions: FeatureOptions = {
  minConfidence: policy.calibration.landmark_confidence_min,
  // Design proposal: avoid dividing by a near-zero shoulder width.
  minShoulderFraction: 0.05,
};

function usable(point: CameraPoint | null, min: number): point is CameraPoint {
  return (
    point !== null &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isFinite(point.confidence) &&
    point.confidence >= min
  );
}

/** Both ears are needed: face_width is the ear-to-ear distance. Nose alone is not enough. */
export function cameraFeatures(
  frame: CameraFrame,
  options: FeatureOptions = defaultFeatureOptions,
): FeatureResult {
  if (frame.quality === 'no_pose') return { ok: false, reason: 'no_pose' };
  if (frame.quality === 'low_confidence') return { ok: false, reason: 'low_confidence' };
  if (frame.quality === 'motion') return { ok: false, reason: 'motion' };
  const { nose, leftEar, rightEar, leftShoulder, rightShoulder } = frame.landmarks;
  const min = options.minConfidence;
  if (
    !usable(leftEar, min) ||
    !usable(rightEar, min) ||
    !usable(leftShoulder, min) ||
    !usable(rightShoulder, min)
  )
    return { ok: false, reason: 'missing_points' };
  const { frameWidth: w, frameHeight: hgt } = frame;
  if (!(w > 0) || !(hgt > 0)) return { ok: false, reason: 'degenerate' };
  const px = (p: CameraPoint) => ({ x: p.x * w, y: p.y * hgt });
  const le = px(leftEar);
  const re = px(rightEar);
  const ls = px(leftShoulder);
  const rs = px(rightShoulder);
  const faceWidth = Math.hypot(le.x - re.x, le.y - re.y);
  const shoulderWidth = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (shoulderWidth < options.minShoulderFraction * Math.hypot(w, hgt) || !(faceWidth > 0))
    return { ok: false, reason: 'degenerate' };
  const midEarY = (le.y + re.y) / 2;
  const midShoulderY = (ls.y + rs.y) / 2;
  return {
    ok: true,
    features: {
      timestampMs: frame.timestampMs,
      r: faceWidth / shoulderWidth,
      h: (midShoulderY - midEarY) / shoulderWidth,
      n: usable(nose, min) ? (midEarY - px(nose).y) / shoulderWidth : null,
    },
  };
}

export interface CameraBaseline {
  r0: number;
  h0: number;
  /** Baseline of `n`; `null`/absent when the nose was not reliable during calibration. */
  n0?: number | null;
}

/**
 * Change from the personal baseline: `rChange = r/r0 - 1`, `hChange = h - h0`.
 * Still dimensionless. Head moving toward the camera tends to raise rChange and a dropping
 * head tends to lower hChange, but thresholds and direction are unvalidated (DEC-002/007).
 */
export function featureChange(features: CameraFeatures, baseline: CameraBaseline) {
  return { rChange: features.r / baseline.r0 - 1, hChange: features.h - baseline.h0 };
}
