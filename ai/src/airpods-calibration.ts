import { median } from './calibration';
import type { CameraLevel } from './camera-window';

/**
 * AirPods wearing-angle calibration (additional feature ③).
 *
 * The earbuds sit at a different angle on every person and every time they are put in, so the
 * pitch of the person's own upright posture is stored as the baseline for each wearing, the
 * same way as the webcam (3 s, upright posture only). Flexion is then
 * `headFlexionDeg(pitch, baselinePitch, sign)`.
 *
 * Values are draft proposals (DEC-003/007). The axis and sign still need the DEC-003
 * measurements. Raw motion stays on the device.
 */
export interface PitchSample {
  /** Monotonic time, ms. */
  t: number;
  pitchRad: number;
}

export type PitchRestart = 'invalid' | 'gap' | 'unstable' | 'time_reversed';

export interface PitchCalibrationOptions {
  durationMs: number;
  minSamples: number;
  /** A sample further than this from the running median restarts the segment. */
  toleranceDeg: number;
  maxGapMs: number;
}

export const draftPitchCalibrationOptions: PitchCalibrationOptions = {
  durationMs: 3000,
  minSamples: 10,
  toleranceDeg: 3,
  maxGapMs: 500,
};

export type PitchCalibrationState =
  | {
      status: 'collecting';
      samples: PitchSample[];
      progress: number;
      lastRestart: PitchRestart | null;
    }
  | { status: 'done'; baselineRad: number };

export function initialPitchCalibration(): PitchCalibrationState {
  return { status: 'collecting', samples: [], progress: 0, lastRestart: null };
}

const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function advancePitchCalibration(
  state: PitchCalibrationState,
  sample: PitchSample,
  options: PitchCalibrationOptions = draftPitchCalibrationOptions,
): PitchCalibrationState {
  if (state.status === 'done') return state;
  const restart = (reason: PitchRestart, keep: PitchSample[] = []): PitchCalibrationState => ({
    status: 'collecting',
    samples: keep,
    progress: 0,
    lastRestart: reason,
  });
  if (!Number.isFinite(sample.t) || !Number.isFinite(sample.pitchRad)) return restart('invalid');
  const previous = state.samples.at(-1);
  if (previous && sample.t < previous.t) return restart('time_reversed', [sample]);
  if (previous && sample.t - previous.t > options.maxGapMs) return restart('gap', [sample]);
  if (state.samples.length) {
    const center = median(state.samples.map((s) => s.pitchRad));
    if (Math.abs(toDeg(sample.pitchRad - center)) > options.toleranceDeg)
      return restart('unstable', [sample]);
  }
  const samples = [...state.samples, sample];
  const span = samples.at(-1)!.t - samples[0].t;
  if (span >= options.durationMs && samples.length >= options.minSamples)
    return { status: 'done', baselineRad: median(samples.map((s) => s.pitchRad)) };
  return {
    status: 'collecting',
    samples,
    progress: Math.min(0.99, span / options.durationMs),
    lastRestart: state.lastRestart,
  };
}

/**
 * Wearing-shift check for the combined mode: the webcam sees no head drop while the AirPods
 * report a flexed head for a long time. That usually means the earbuds moved, not the head,
 * so the app suggests calibrating again instead of alerting on posture.
 */
export interface WearCheckOptions {
  /** AirPods flexion at or above this counts as "AirPods say the head is down". */
  cautionDeg: number;
  /** How long the disagreement must last before suggesting recalibration. */
  holdMs: number;
}

export const draftWearCheckOptions: WearCheckOptions = { cautionDeg: 15, holdMs: 30_000 };

export interface WearCheckState {
  since: number | null;
}

export interface WearCheckInput {
  t: number;
  /** Webcam head-drop level for the same window (null when the webcam had no data). */
  cameraDropLevel: CameraLevel | null;
  headFlexionDeg: number | null;
}

export const wearShiftMessage =
  '착용 위치가 바뀌었을 수 있어요. 바른 자세로 AirPods 기준을 다시 잡아 주세요.';

export function advanceWearCheck(
  state: WearCheckState,
  input: WearCheckInput,
  options: WearCheckOptions = draftWearCheckOptions,
): { state: WearCheckState; suspect: boolean } {
  const disagree =
    input.cameraDropLevel === 'normal' &&
    input.headFlexionDeg !== null &&
    input.headFlexionDeg >= options.cautionDeg;
  // Missing webcam or AirPods data is not evidence either way: the check starts over.
  if (!disagree) return { state: { since: null }, suspect: false };
  const since = state.since ?? input.t;
  return { state: { since }, suspect: input.t - since >= options.holdMs };
}
