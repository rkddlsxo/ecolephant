import { describe, expect, it } from 'vitest';
import {
  advanceAlerts,
  closeAlert,
  confirmDelivery,
  initialAlerts,
  type AlertCommand,
} from './alerts';
import { deriveWindow } from './decision';
import policy from './policy.json';
import type { Mode, Observation } from './types';

const { first_after_ms, second_after_first_ms, cooldown_ms, correction_stable_ms } = policy.alerts;
const observation_ms = policy.alerts.correction_observation_ms;

const HIGH: Observation = { cameraDeg: 40, headDeg: 40 };
const OK: Observation = { cameraDeg: 5, headDeg: 5 };
const CAUTION: Observation = { cameraDeg: 20, headDeg: 5 };
const HEAD_DOWN: Observation = { cameraDeg: 5, headDeg: 35 }; // combined head_flexion ≥ 30°
const MOTION: Observation = { cameraDeg: null, headDeg: null, quality: 'motion' };

interface Step {
  obs: Observation;
  mode?: Mode;
  epoch?: number;
}

/**
 * Drives the alert state machine with 1 s windows from deriveWindow(), like the controller.
 * `deliver` decides whether a stage-1 attempt was actually shown (confirmDelivery).
 */
function simulate(steps: Step[], { deliver = true, state = initialAlerts(), startMs = 0 } = {}) {
  const log: AlertCommand[] = [];
  steps.forEach((step, i) => {
    const sample = deriveWindow(step.mode ?? 'combined', step.obs, {
      seq: i + 1,
      elapsed_start_ms: startMs + i * 1000,
      duration_ms: 1000,
      calibration_epoch: step.epoch ?? 1,
    });
    const result = advanceAlerts(state, sample);
    state = result.state;
    for (const command of result.commands) {
      log.push(command);
      if (command.type === 'deliver')
        state = confirmDelivery(state, command.key, command.stage, command.elapsedMs, deliver);
    }
  });
  return { state, log, endMs: startMs + steps.length * 1000 };
}

const repeat = (obs: Observation, seconds: number, extra: Omit<Step, 'obs'> = {}): Step[] =>
  Array.from({ length: seconds }, () => ({ obs, ...extra }));

const delivers = (log: AlertCommand[]) =>
  log.filter((c): c is Extract<AlertCommand, { type: 'deliver' }> => c.type === 'deliver');
const corrections = (log: AlertCommand[]) =>
  log.filter((c): c is Extract<AlertCommand, { type: 'correction' }> => c.type === 'correction');

describe('alert timing', () => {
  it('sends stage 1 after 20 s of continuous high posture, not before', () => {
    const early = simulate(repeat(HIGH, first_after_ms / 1000 - 1));
    expect(delivers(early.log)).toEqual([]);
    const { log } = simulate(repeat(HIGH, first_after_ms / 1000));
    expect(delivers(log)).toEqual([{ type: 'deliver', key: 1, stage: 1, elapsedMs: 20_000 }]);
  });

  it('sends stage 2 once, 30 s after a delivered stage 1', () => {
    const seconds = (first_after_ms + second_after_first_ms) / 1000;
    const { log } = simulate(repeat(HIGH, seconds + 30));
    expect(delivers(log)).toEqual([
      { type: 'deliver', key: 1, stage: 1, elapsedMs: 20_000 },
      { type: 'deliver', key: 1, stage: 2, elapsedMs: 50_000 },
    ]);
  });

  it('does not send stage 2 or retry when stage 1 was not delivered', () => {
    const { log } = simulate(repeat(HIGH, 100), { deliver: false });
    expect(delivers(log)).toEqual([{ type: 'deliver', key: 1, stage: 1, elapsedMs: 20_000 }]);
    expect(corrections(log)).toEqual([]); // no delivered alert, no correction sample
  });

  it('restarts the 20 s count when the posture recovers in between', () => {
    const { log } = simulate([...repeat(HIGH, 15), { obs: OK }, ...repeat(HIGH, 15)]);
    expect(delivers(log)).toEqual([]);
  });

  it('does not alert on caution', () => {
    expect(delivers(simulate(repeat(CAUTION, 60)).log)).toEqual([]);
  });

  it('treats combined head flexion ≥ 30° as a candidate even though the level is caution', () => {
    const { log } = simulate(repeat(HEAD_DOWN, 20));
    expect(delivers(log)).toHaveLength(1);
  });

  it('does not apply the head-flexion exception to AirPods-only caution', () => {
    // AirPods-only 20° is caution / head_flexion but below 30° → not a candidate
    const { log } = simulate(repeat({ cameraDeg: null, headDeg: 20 }, 30, { mode: 'airpods' }));
    expect(delivers(log)).toEqual([]);
  });
});

describe('interruptions', () => {
  it.each([
    ['invalid quality', { obs: MOTION }],
    ['mode change', { obs: { cameraDeg: 40, headDeg: null } }],
    ['recalibration', { obs: HIGH, epoch: 2 }],
  ] as [string, Step][])('resets the candidate time on %s', (_label, interruption) => {
    const after = interruption.epoch ? { epoch: 2 } : {};
    const { log } = simulate([...repeat(HIGH, 15), interruption, ...repeat(HIGH, 15, after)]);
    expect(delivers(log)).toEqual([]);
  });

  it('closes a delivered alert as unknown when the signal becomes invalid', () => {
    const { log } = simulate([...repeat(HIGH, 25), { obs: MOTION }]);
    expect(corrections(log)).toEqual([
      { type: 'correction', key: 1, outcome: 'unknown', elapsedMs: 25_000 },
    ]);
  });

  it('closeAlert reports unknown only for a delivered alert and keeps the cooldown', () => {
    const delivered = simulate(repeat(HIGH, 20)).state;
    const closed = closeAlert(delivered, 21_000);
    expect(closed.commands).toEqual([
      { type: 'correction', key: 1, outcome: 'unknown', elapsedMs: 21_000 },
    ]);
    expect(closed.state).toMatchObject({ cooldownUntilMs: 20_000 + cooldown_ms, key: null });
    expect(closeAlert(initialAlerts(), 5_000).commands).toEqual([]);
  });
});

describe('correction', () => {
  it('records corrected after 3 s of recovery, timed from the first recovered window', () => {
    const { log } = simulate([...repeat(HIGH, 22), ...repeat(OK, correction_stable_ms / 1000)]);
    expect(corrections(log)).toEqual([
      { type: 'correction', key: 1, outcome: 'corrected', elapsedMs: 22_000 },
    ]);
  });

  it('needs the recovery to be continuous', () => {
    const { log } = simulate([
      ...repeat(HIGH, 22),
      ...repeat(OK, 2),
      { obs: HIGH },
      ...repeat(OK, 2),
    ]);
    expect(corrections(log)).toEqual([]);
  });

  it('closes the observation as unknown after 120 s without recovery', () => {
    const seconds = (first_after_ms + observation_ms) / 1000;
    const { log } = simulate(repeat(HIGH, seconds));
    expect(corrections(log)).toEqual([
      { type: 'correction', key: 1, outcome: 'unknown', elapsedMs: 20_000 + observation_ms },
    ]);
    expect(delivers(log).map((c) => c.stage)).toEqual([1, 2]);
  });
});

describe('cooldown', () => {
  it('suppresses a new episode within 5 min of a delivered stage 1', () => {
    const first = simulate([...repeat(HIGH, 22), ...repeat(OK, 3)]);
    const again = simulate(repeat(HIGH, 60), { state: first.state, startMs: first.endMs });
    expect(delivers(again.log)).toEqual([]);
  });

  it('allows a new episode with a new key once the cooldown has passed', () => {
    const first = simulate([...repeat(HIGH, 22), ...repeat(OK, 3)]);
    const later = 20_000 + cooldown_ms;
    const again = simulate(repeat(HIGH, 20), { state: first.state, startMs: later });
    expect(delivers(again.log)).toEqual([
      { type: 'deliver', key: 2, stage: 1, elapsedMs: later + 20_000 },
    ]);
  });

  it('does not start a cooldown when stage 1 was not delivered', () => {
    const failed = simulate([...repeat(HIGH, 22), ...repeat(OK, 3)], { deliver: false });
    expect(failed.state.cooldownUntilMs).toBe(0);
    const again = simulate(repeat(HIGH, 20), { state: failed.state, startMs: failed.endMs });
    expect(delivers(again.log)).toEqual([
      { type: 'deliver', key: 2, stage: 1, elapsedMs: failed.endMs + 20_000 },
    ]);
  });
});
