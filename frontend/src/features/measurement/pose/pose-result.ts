import type { CameraModelResult } from '../model-adapter';

/** MediaPipe Pose landmark indices used by the camera contract. */
export const POSE_INDEX = {
  nose: 0,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
} as const;

export type LandmarkName = keyof typeof POSE_INDEX;
type Point = { x: number; y: number; confidence: number };
type Landmarks = CameraModelResult['landmarks'];

/** Shape of one MediaPipe NormalizedLandmark (kept local so tests need no WASM). */
export interface RawLandmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
  presence?: number;
}

export interface QualityOptions {
  /** policy.calibration.landmark_confidence_min (design proposal, DEC-007). */
  minConfidence: number;
  /**
   * Motion check: head/shoulder centre displacement, in shoulder widths, measured against a
   * reference frame at least `motionBaselineMs` old. Draft values, not validated (DEC-007).
   */
  motionLimit: number;
  motionBaselineMs: number;
  /** Older references are discarded (policy.quality.max_sample_age_ms). */
  motionMaxGapMs: number;
}

export const draftQualityOptions: QualityOptions = {
  minConfidence: 0.7,
  motionLimit: 0.15,
  motionBaselineMs: 250,
  motionMaxGapMs: 500,
};

/** Recent pixel-space centres used only for the local motion check. Never leaves the device. */
export interface MotionSample {
  timestampMs: number;
  head: { x: number; y: number };
  shoulder: { x: number; y: number };
  shoulderWidth: number;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function toPoint(raw: RawLandmark | undefined): Point | null {
  if (!raw || !finite(raw.x) || !finite(raw.y)) return null;
  // Points outside the frame are extrapolated by the model; treat them as missing.
  if (raw.x < 0 || raw.x > 1 || raw.y < 0 || raw.y > 1) return null;
  const visibility = finite(raw.visibility) ? raw.visibility : 0;
  const presence = finite(raw.presence) ? raw.presence : 1;
  const confidence = Math.min(1, Math.max(0, Math.min(visibility, presence)));
  return { x: raw.x, y: raw.y, confidence };
}

export function emptyLandmarks(): Landmarks {
  return { nose: null, leftEar: null, rightEar: null, leftShoulder: null, rightShoulder: null };
}

export function pickLandmarks(pose: readonly RawLandmark[] | undefined): Landmarks {
  if (!pose) return emptyLandmarks();
  return {
    nose: toPoint(pose[POSE_INDEX.nose]),
    leftEar: toPoint(pose[POSE_INDEX.leftEar]),
    rightEar: toPoint(pose[POSE_INDEX.rightEar]),
    leftShoulder: toPoint(pose[POSE_INDEX.leftShoulder]),
    rightShoulder: toPoint(pose[POSE_INDEX.rightShoulder]),
  };
}

function confident(point: Point | null, min: number): point is Point {
  return point !== null && point.confidence >= min;
}

/** Pixel-space centres; normalized coordinates are scaled by the real frame size. */
export function motionSample(
  landmarks: Landmarks,
  frameWidth: number,
  frameHeight: number,
  timestampMs: number,
  minConfidence: number,
): MotionSample | null {
  const { leftShoulder: ls, rightShoulder: rs } = landmarks;
  if (!confident(ls, minConfidence) || !confident(rs, minConfidence)) return null;
  const head = [landmarks.nose, landmarks.leftEar, landmarks.rightEar].filter((point) =>
    confident(point, minConfidence),
  ) as Point[];
  if (head.length === 0) return null;
  const px = (point: Point) => ({ x: point.x * frameWidth, y: point.y * frameHeight });
  const a = px(ls);
  const b = px(rs);
  const shoulderWidth = Math.hypot(a.x - b.x, a.y - b.y);
  if (!(shoulderWidth > 0)) return null;
  const headPx = head.map(px);
  return {
    timestampMs,
    head: {
      x: headPx.reduce((sum, p) => sum + p.x, 0) / headPx.length,
      y: headPx.reduce((sum, p) => sum + p.y, 0) / headPx.length,
    },
    shoulder: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    shoulderWidth,
  };
}

/** Keeps only references usable for the next motion check. */
export function pruneHistory(
  history: readonly MotionSample[],
  nowMs: number,
  options: QualityOptions,
): MotionSample[] {
  return history.filter(
    (sample) => sample.timestampMs < nowMs && nowMs - sample.timestampMs <= options.motionMaxGapMs,
  );
}

export function isMoving(
  current: MotionSample,
  history: readonly MotionSample[],
  options: QualityOptions,
): boolean {
  // Newest reference that is at least the baseline old: per-frame jitter must not count.
  let reference: MotionSample | undefined;
  for (const sample of history) {
    const age = current.timestampMs - sample.timestampMs;
    if (age >= options.motionBaselineMs && age <= options.motionMaxGapMs) {
      if (!reference || sample.timestampMs > reference.timestampMs) reference = sample;
    }
  }
  if (!reference) return false;
  const scale = (current.shoulderWidth + reference.shoulderWidth) / 2;
  const shift = (p: { x: number; y: number }, q: { x: number; y: number }) =>
    Math.hypot(p.x - q.x, p.y - q.y) / scale;
  const widthChange = Math.abs(current.shoulderWidth - reference.shoulderWidth) / scale;
  return (
    Math.max(
      shift(current.head, reference.head),
      shift(current.shoulder, reference.shoulder),
      widthChange,
    ) > options.motionLimit
  );
}

export interface FrameInput {
  timestampMs: number;
  frameWidth: number;
  frameHeight: number;
  /** First pose from PoseLandmarkerResult.landmarks, or undefined when none. */
  pose: readonly RawLandmark[] | undefined;
}

export interface FrameOutput {
  result: CameraModelResult;
  history: MotionSample[];
}

/**
 * Converts one model output to the camera contract. Low quality is never upgraded to valid:
 * missing or low-confidence required points give `low_confidence`, and fast movement `motion`.
 */
export function toCameraModelResult(
  input: FrameInput,
  history: readonly MotionSample[],
  options: QualityOptions = draftQualityOptions,
): FrameOutput {
  const { timestampMs, frameWidth, frameHeight } = input;
  const base = { timestampMs, frameWidth, frameHeight };
  const kept = pruneHistory(history, timestampMs, options);
  if (!input.pose || input.pose.length === 0)
    return { result: { ...base, quality: 'no_pose', landmarks: emptyLandmarks() }, history: [] };

  const landmarks = pickLandmarks(input.pose);
  const sample = motionSample(
    landmarks,
    frameWidth,
    frameHeight,
    timestampMs,
    options.minConfidence,
  );
  if (!sample) return { result: { ...base, quality: 'low_confidence', landmarks }, history: [] };

  const quality = isMoving(sample, kept, options) ? 'motion' : 'valid';
  return { result: { ...base, quality, landmarks }, history: [...kept, sample] };
}
