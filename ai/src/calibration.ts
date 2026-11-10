import policy from './policy.json';
import type { CameraBaseline, CameraFeatures, FeatureResult } from './camera-features';

/**
 * Collects a continuous stable segment and stores its median as the personal baseline
 * (docs/measurement/signal-pipeline.md, 보정). Pure state machine: feed one feature result per
 * analysed frame. The tolerances are draft values awaiting DEC-007.
 */
export interface CalibrationOptions {
  stableDurationMs: number;
  /** A gap longer than this between usable frames restarts the segment. */
  maxGapMs: number;
  /** Allowed |r / median_r - 1| inside the segment. */
  rTolerance: number;
  /** Allowed |h - median_h| inside the segment. */
  hTolerance: number;
  minSamples: number;
}

export const draftCalibrationOptions: CalibrationOptions = {
  stableDurationMs: policy.calibration.stable_duration_ms,
  maxGapMs: policy.quality.max_sample_age_ms,
  rTolerance: 0.08,
  hTolerance: 0.06,
  minSamples: 10,
};

/** Why the current segment was restarted, for on-screen guidance. */
export type CalibrationRestart =
  | 'no_pose'
  | 'low_confidence'
  | 'motion'
  | 'missing_points'
  | 'degenerate'
  | 'unstable'
  | 'gap'
  | 'time_reversed';

export type CalibrationState =
  | {
      status: 'collecting';
      samples: CameraFeatures[];
      /** 0..1 share of the stable duration collected in the current segment. */
      progress: number;
      lastRestart: CalibrationRestart | null;
      restarts: number;
    }
  | {
      status: 'done';
      baseline: CameraBaseline & { samples: number; startedMs: number; endedMs: number };
    };

export function initialCalibration(): CalibrationState {
  return { status: 'collecting', samples: [], progress: 0, lastRestart: null, restarts: 0 };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median of `n` only when at least half of the segment had a usable nose; otherwise null. */
function noseBaseline(samples: readonly CameraFeatures[]): number | null {
  const values = samples
    .map((s) => s.n)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  return values.length * 2 >= samples.length ? median(values) : null;
}

function restart(
  state: Extract<CalibrationState, { status: 'collecting' }>,
  reason: CalibrationRestart,
  seed: CameraFeatures[] = [],
): CalibrationState {
  const counted = state.samples.length > 0 ? 1 : 0;
  return {
    status: 'collecting',
    samples: seed,
    progress: 0,
    lastRestart: reason,
    restarts: state.restarts + counted,
  };
}

function stable(samples: readonly CameraFeatures[], options: CalibrationOptions) {
  const r = median(samples.map((s) => s.r));
  const h = median(samples.map((s) => s.h));
  return samples.every(
    (s) => Math.abs(s.r / r - 1) <= options.rTolerance && Math.abs(s.h - h) <= options.hTolerance,
  );
}

export function advanceCalibration(
  state: CalibrationState,
  result: FeatureResult,
  options: CalibrationOptions = draftCalibrationOptions,
): CalibrationState {
  if (state.status === 'done') return state;
  if (!result.ok) return restart(state, result.reason);
  const sample = result.features;
  const last = state.samples[state.samples.length - 1];
  if (last && sample.timestampMs <= last.timestampMs) return restart(state, 'time_reversed');
  if (last && sample.timestampMs - last.timestampMs > options.maxGapMs)
    return restart(state, 'gap', [sample]);

  const samples = [...state.samples, sample];
  // A jump away from the segment starts a new segment from the current sample.
  if (!stable(samples, options)) return restart(state, 'unstable', [sample]);

  const span = sample.timestampMs - samples[0].timestampMs;
  if (span >= options.stableDurationMs && samples.length >= options.minSamples)
    return {
      status: 'done',
      baseline: {
        r0: median(samples.map((s) => s.r)),
        h0: median(samples.map((s) => s.h)),
        n0: noseBaseline(samples),
        samples: samples.length,
        startedMs: samples[0].timestampMs,
        endedMs: sample.timestampMs,
      },
    };
  return {
    ...state,
    samples,
    progress: Math.min(1, span / options.stableDurationMs),
  };
}
