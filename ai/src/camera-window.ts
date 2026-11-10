import policy from './policy.json';
import { median } from './calibration';
import type { CameraBaseline, FeatureFailure, FeatureResult } from './camera-features';

/**
 * Webcam-only judgement from change against the personal baseline (DEC-002, team-agreed
 * 2026-11-10). No degrees are produced here: the webcam features are dimensionless and the
 * mapping to an angle waits for the side-view validation experiment.
 *
 * Flow: one FeatureResult per analysed frame → `summarizeCameraWindow` per 1 s window →
 * `judgeCameraChange` → level + posture type.
 */

/** Draft thresholds (design proposals, DEC-007). Tune with the validation experiment. */
export interface CameraChangeThresholds {
  /** rChange (= r/r0 - 1) at or above this means the head moved toward the camera. */
  forward: { caution: number; high: number };
  /** hChange (= h - h0) at or below this (negative) means the ears dropped toward the shoulders. */
  drop: { caution: number; high: number };
  /** nChange (= n - n0) at or below this (negative) means the nose dropped relative to the ears. */
  noseDrop: { caution: number; high: number };
}

export const draftCameraChangeThresholds: CameraChangeThresholds = {
  forward: { caution: 0.1, high: 0.2 },
  drop: { caution: -0.1, high: -0.2 },
  noseDrop: { caution: -0.1, high: -0.2 },
};

export interface CameraWindowOptions {
  /** Share of analysed frames in the window that must be usable. */
  minCoverage: number;
  /** Fewer analysed frames than this in a window is treated as no sensor data. */
  minFrames: number;
}

export const defaultCameraWindowOptions: CameraWindowOptions = {
  minCoverage: policy.quality.min_valid_coverage,
  // Design proposal: at ~14 fps a 1 s window has ~14 frames; 3 keeps a slow laptop usable.
  minFrames: 3,
};

export type CameraWindowFailure = 'no_sensor' | 'low_confidence' | 'motion';

export type CameraWindowSummary =
  | {
      ok: true;
      /** Median change over usable frames in the window. */
      rChange: number;
      hChange: number;
      /** `null` when the baseline or the window lacks a reliable nose. */
      nChange: number | null;
      coverage: number;
      frames: number;
    }
  | { ok: false; reason: CameraWindowFailure; coverage: number; frames: number };

function windowFailure(failures: readonly FeatureFailure[]): CameraWindowFailure {
  const motion = failures.filter((f) => f === 'motion').length;
  // Mostly motion → motion; anything else (missing points, low confidence, no pose,
  // degenerate) is "not enough reliable data", never "normal".
  return motion * 2 >= failures.length && motion > 0 ? 'motion' : 'low_confidence';
}

/**
 * Summarises the frames analysed inside one window. Never fills missing frames with normal
 * values: a window below the coverage minimum is reported as a failure.
 */
export function summarizeCameraWindow(
  results: readonly FeatureResult[],
  baseline: CameraBaseline,
  options: CameraWindowOptions = defaultCameraWindowOptions,
): CameraWindowSummary {
  const frames = results.length;
  if (frames < options.minFrames) return { ok: false, reason: 'no_sensor', coverage: 0, frames };
  const usable = results.flatMap((r) => (r.ok ? [r.features] : []));
  const coverage = usable.length / frames;
  if (coverage < options.minCoverage) {
    const failures = results.flatMap((r) => (r.ok ? [] : [r.reason]));
    return { ok: false, reason: windowFailure(failures), coverage, frames };
  }
  const n0 = baseline.n0;
  const noses = usable
    .map((f) => f.n)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  // Same rule as calibration: use the nose only when at least half of the usable frames have it.
  const nChange =
    typeof n0 === 'number' && noses.length * 2 >= usable.length ? median(noses) - n0 : null;
  return {
    ok: true,
    rChange: median(usable.map((f) => f.r / baseline.r0 - 1)),
    hChange: median(usable.map((f) => f.h - baseline.h0)),
    nChange,
    coverage,
    frames,
  };
}

export type CameraLevel = 'normal' | 'caution' | 'high';
/**
 * Posture type (team-agreed MVP set, 2026-11-10): chin_forward = head pushed toward the
 * screen without dropping, head_down = head dropped without moving forward, combined = both.
 * Rounded shoulders and cervical straightening are out of scope.
 */
export type PostureType = 'chin_forward' | 'head_down' | 'combined';

export interface CameraJudgement {
  level: CameraLevel;
  /** `null` when the level is normal. */
  type: PostureType | null;
  /** Which signal decided each part, for debugging and on-screen hints. */
  forwardLevel: CameraLevel;
  dropLevel: CameraLevel;
}

function levelAbove(value: number, { caution, high }: { caution: number; high: number }) {
  return value >= high ? 'high' : value >= caution ? 'caution' : 'normal';
}

function levelBelow(value: number, { caution, high }: { caution: number; high: number }) {
  return value <= high ? 'high' : value <= caution ? 'caution' : 'normal';
}

const rank: Record<CameraLevel, number> = { normal: 0, caution: 1, high: 2 };
const worst = (a: CameraLevel, b: CameraLevel) => (rank[a] >= rank[b] ? a : b);

/** Level and posture type from a valid window summary. Pure; thresholds are draft values. */
export function judgeCameraChange(
  summary: Extract<CameraWindowSummary, { ok: true }>,
  thresholds: CameraChangeThresholds = draftCameraChangeThresholds,
): CameraJudgement {
  const forwardLevel = levelAbove(summary.rChange, thresholds.forward);
  const dropFromEars = levelBelow(summary.hChange, thresholds.drop);
  const dropFromNose =
    summary.nChange === null ? 'normal' : levelBelow(summary.nChange, thresholds.noseDrop);
  const dropLevel = worst(dropFromEars, dropFromNose);
  const level = worst(forwardLevel, dropLevel);
  const forward = forwardLevel !== 'normal';
  const drop = dropLevel !== 'normal';
  const type: PostureType | null =
    forward && drop ? 'combined' : forward ? 'chin_forward' : drop ? 'head_down' : null;
  return { level, type, forwardLevel, dropLevel };
}
