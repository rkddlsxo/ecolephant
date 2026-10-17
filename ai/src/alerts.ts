import policy from './policy.json';
import type { DerivedWindow } from './types';

export type AlertCommand =
  | { type: 'deliver'; key: number; stage: 1 | 2; elapsedMs: number }
  | { type: 'correction'; key: number; outcome: 'corrected' | 'unknown'; elapsedMs: number };
export interface AlertState {
  candidateMs: number;
  cooldownUntilMs: number;
  nextKey: number;
  key: number | null;
  firstAtMs: number | null;
  attempted: boolean;
  secondAttempted: boolean;
  recoveryStartMs: number | null;
  mode: string;
  epoch: number;
}
export function initialAlerts(): AlertState {
  return {
    candidateMs: 0,
    cooldownUntilMs: 0,
    nextKey: 1,
    key: null,
    firstAtMs: null,
    attempted: false,
    secondAttempted: false,
    recoveryStartMs: null,
    mode: '',
    epoch: 0,
  };
}
export function confirmDelivery(
  state: AlertState,
  key: number,
  stage: 1 | 2,
  elapsedMs: number,
  delivered: boolean,
): AlertState {
  if (state.key !== key || stage !== 1 || !delivered) return state;
  return { ...state, firstAtMs: elapsedMs, cooldownUntilMs: elapsedMs + policy.alerts.cooldown_ms };
}
export function closeAlert(
  state: AlertState,
  elapsedMs: number,
): { state: AlertState; commands: AlertCommand[] } {
  const commands: AlertCommand[] =
    state.key !== null && state.firstAtMs !== null
      ? [{ type: 'correction', key: state.key, outcome: 'unknown', elapsedMs }]
      : [];
  return {
    state: { ...initialAlerts(), cooldownUntilMs: state.cooldownUntilMs, nextKey: state.nextKey },
    commands,
  };
}
export function advanceAlerts(
  previous: AlertState,
  sample: DerivedWindow,
): { state: AlertState; commands: AlertCommand[] } {
  let state = { ...previous };
  const commands: AlertCommand[] = [];
  const end = sample.elapsed_start_ms + sample.duration_ms;
  const disrupted =
    sample.quality !== 'valid' ||
    (state.mode && state.mode !== sample.active_mode) ||
    (state.epoch && state.epoch !== sample.calibration_epoch);
  if (disrupted) {
    const closed = closeAlert(state, sample.elapsed_start_ms);
    state = closed.state;
    commands.push(...closed.commands);
  }
  state.mode = sample.active_mode;
  state.epoch = sample.calibration_epoch;
  if (sample.quality !== 'valid') return { state, commands };
  const candidate =
    sample.posture_level === 'high' ||
    (sample.active_mode === 'combined' &&
      sample.reason_code === 'head_flexion' &&
      (sample.head_flexion_deg ?? 0) >= policy.thresholds_deg.high);
  if (
    state.firstAtMs !== null &&
    end - state.firstAtMs >= policy.alerts.correction_observation_ms
  ) {
    const closed = closeAlert(state, end);
    state = { ...closed.state, mode: sample.active_mode, epoch: sample.calibration_epoch };
    commands.push(...closed.commands);
  }
  if (!candidate) {
    state.candidateMs = 0;
    if (state.firstAtMs !== null && state.key !== null) {
      state.recoveryStartMs ??= sample.elapsed_start_ms;
      if (end - state.recoveryStartMs >= policy.alerts.correction_stable_ms) {
        commands.push({
          type: 'correction',
          key: state.key,
          outcome: 'corrected',
          elapsedMs: state.recoveryStartMs,
        });
        state = {
          ...initialAlerts(),
          cooldownUntilMs: state.cooldownUntilMs,
          nextKey: state.nextKey,
          mode: sample.active_mode,
          epoch: sample.calibration_epoch,
        };
      }
    } else {
      state.attempted = false;
      state.key = null;
    }
    return { state, commands };
  }
  state.recoveryStartMs = null;
  state.candidateMs += sample.duration_ms;
  if (
    !state.attempted &&
    state.candidateMs >= policy.alerts.first_after_ms &&
    end >= state.cooldownUntilMs
  ) {
    state.key = state.nextKey++;
    state.attempted = true;
    commands.push({ type: 'deliver', key: state.key, stage: 1, elapsedMs: end });
  } else if (
    state.firstAtMs !== null &&
    state.key !== null &&
    !state.secondAttempted &&
    end - state.firstAtMs >= policy.alerts.second_after_first_ms
  ) {
    state.secondAttempted = true;
    commands.push({ type: 'deliver', key: state.key, stage: 2, elapsedMs: end });
  }
  return { state, commands };
}
