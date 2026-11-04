import {
  advanceAlerts,
  closeAlert,
  confirmDelivery,
  demoObservation,
  deriveWindow,
  initialAlerts,
  policy,
} from '@ecolephant/ai';
import type { ActiveMode, AlertCommand, DerivedWindow, Mode } from '@ecolephant/ai';
import { api, errorMessage, isMissingSession } from '../../api/client';
import type { EventPayload, Sample, Session, SessionCreate, SessionEvent } from '../../api/client';
import { queryClient } from '../../api/query';
import { initialMeasurement, useMeasurement } from '../../state/measurement';
import { usePreferences } from '../../state/preferences';

function confirmedBatch(
  value: unknown,
  count: number,
  lastSequence: number,
  acknowledgement: 'acknowledged_through_seq' | 'acknowledged_through_event_seq',
) {
  const receipt = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const validNumber = (number: unknown): number is number =>
    typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  const accepted = receipt.accepted_count;
  const duplicate = receipt.duplicate_count;
  const through = receipt[acknowledgement];
  if (
    !validNumber(accepted) ||
    !validNumber(duplicate) ||
    !validNumber(through) ||
    accepted + duplicate !== count ||
    through < lastSequence
  )
    throw new Error('저장 확인에 실패했습니다. 다시 시도해 주세요.');
}

class MeasurementController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private origin = 0;
  private cursor = 0;
  private sequence = 0;
  private eventSequence = 0;
  private samples: DerivedWindow[] = [];
  private events: SessionEvent[] = [];
  private alerts = initialAlerts();
  private alertIds = new Map<number, string>();
  private confirmed = new Set<string>();
  private lastMode: ActiveMode = 'combined';
  private flushPromise: Promise<void> | null = null;
  private finishPromise: Promise<Session | undefined> | null = null;
  private finalTarget: number | null = null;
  private endingFrom: 'active' | 'paused' | 'recalibrating' | null = null;
  private calibrationUntil: number | null = null;
  private starting: { body: SessionCreate; key: string; origin: number } | null = null;
  private flushAt = 0;
  private unavailableUntil = 0;

  reset({ preservePendingStart = false }: { preservePendingStart?: boolean } = {}) {
    const { phase, saving } = useMeasurement.getState();
    if (!['idle', 'completed'].includes(phase) || saving || this.flushPromise || this.finishPromise)
      return false;
    return this.clear(preservePendingStart);
  }

  discardMissing() {
    const { phase, missingSession, saving } = useMeasurement.getState();
    if (phase !== 'ending' || !missingSession || saving || this.flushPromise || this.finishPromise)
      return false;
    return this.clear(false);
  }

  private clear(preservePendingStart: boolean) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.origin = 0;
    this.cursor = 0;
    this.sequence = 0;
    this.eventSequence = 0;
    this.samples = [];
    this.events = [];
    this.alerts = initialAlerts();
    this.alertIds.clear();
    this.confirmed.clear();
    this.lastMode = 'combined';
    this.finalTarget = null;
    this.endingFrom = null;
    this.calibrationUntil = null;
    if (!preservePendingStart) this.starting = null;
    this.flushAt = 0;
    this.unavailableUntil = 0;
    useMeasurement.setState({ ...initialMeasurement, recent: [] }, true);
    return true;
  }

  private markMissing() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    useMeasurement.setState({
      phase: 'ending',
      saving: false,
      missingSession: true,
      alert: null,
      error: '기록을 찾을 수 없어 저장할 수 없습니다.',
    });
  }

  async start(mode: Mode) {
    const current = useMeasurement.getState();
    if (this.finishPromise) return;
    if (['active', 'paused', 'recalibrating', 'ending', 'starting'].includes(current.phase)) return;
    if (!this.starting || this.starting.body.requested_mode !== mode) {
      this.starting = {
        body: {
          client_session_id: crypto.randomUUID(),
          started_at: new Date().toISOString(),
          requested_mode: mode,
          policy_id: policy.policy_id,
          initial_calibration_epoch: 1,
          data_source: 'demo',
        },
        key: crypto.randomUUID(),
        origin: performance.now(),
      };
    }
    useMeasurement.setState({
      ...initialMeasurement,
      phase: 'starting',
      mode,
      scenario: current.scenario,
      camera: current.camera,
      head: current.head,
    });
    try {
      const session = await api.create(this.starting.body, this.starting.key);
      this.origin = this.starting.origin;
      this.cursor = 0;
      this.sequence = 0;
      this.eventSequence = 0;
      this.samples = [];
      this.events = [];
      this.alerts = initialAlerts();
      this.alertIds.clear();
      this.confirmed.clear();
      this.finalTarget = null;
      this.endingFrom = null;
      this.calibrationUntil = null;
      this.lastMode = mode;
      this.unavailableUntil = Math.ceil(performance.now() - this.origin);
      this.starting = null;
      this.flushAt = performance.now();
      useMeasurement.setState({ session, phase: 'active', mode });
      this.tick();
      this.timer = setInterval(() => this.tick(), 250);
    } catch (error) {
      useMeasurement.setState({ phase: 'idle', error: errorMessage(error) });
      throw error;
    }
  }

  private addEvent(payload: EventPayload, elapsedMs = this.cursor) {
    const event = {
      ...payload,
      event_id: crypto.randomUUID(),
      event_seq: ++this.eventSequence,
      elapsed_ms: elapsedMs,
    } as SessionEvent;
    this.events.push(event);
    useMeasurement.setState({ pending: this.samples.length + this.events.length });
  }

  private commands(commands: AlertCommand[]) {
    for (const command of commands) {
      if (!this.alertIds.has(command.key)) this.alertIds.set(command.key, crypto.randomUUID());
      if (command.type === 'deliver') {
        if (usePreferences.getState().muted) {
          this.addEvent(
            {
              type: 'alert_delivery',
              data: {
                alert_id: this.alertIds.get(command.key)!,
                stage: command.stage,
                channel: 'screen',
                result: 'muted',
              },
            },
            command.elapsedMs,
          );
        } else {
          useMeasurement.setState({ alert: command });
        }
      } else {
        this.addEvent(
          {
            type: 'correction_observed',
            data: { alert_id: this.alertIds.get(command.key)!, outcome: command.outcome },
          },
          command.elapsedMs,
        );
        useMeasurement.setState({ alert: null });
      }
    }
  }

  confirmScreenAlert(key: number, stage: 1 | 2) {
    const current = useMeasurement.getState();
    const identity = `${key}:${stage}`;
    if (
      !current.alert ||
      current.alert.key !== key ||
      current.alert.stage !== stage ||
      this.confirmed.has(identity) ||
      document.hidden
    )
      return;
    this.confirmed.add(identity);
    const elapsed = this.cursor;
    this.addEvent(
      {
        type: 'alert_delivery',
        data: { alert_id: this.alertIds.get(key)!, stage, channel: 'screen', result: 'delivered' },
      },
      elapsed,
    );
    this.alerts = confirmDelivery(this.alerts, key, stage, elapsed, true);
  }

  private close() {
    const result = closeAlert(this.alerts, this.cursor);
    this.alerts = result.state;
    this.commands(result.commands);
    useMeasurement.setState({ alert: null });
  }

  private advance(target: number) {
    let store = useMeasurement.getState();
    const gap = target - this.cursor > 1500;
    while (this.cursor < target && this.samples.length < policy.transport.memory_queue_windows) {
      const duration = Math.min(1000, target - this.cursor);
      const stale = gap || this.cursor < this.unavailableUntil || document.hidden;
      const isCalibrating = this.calibrationUntil !== null && this.cursor < this.calibrationUntil;
      if (this.calibrationUntil !== null && this.cursor >= this.calibrationUntil) {
        this.addEvent({ type: 'calibration_completed', data: { calibration_epoch: store.epoch } });
        this.calibrationUntil = null;
        if (store.phase !== 'ending') useMeasurement.setState({ phase: 'active' });
        store = useMeasurement.getState();
      }
      const observation = demoObservation(store.scenario, this.cursor, {
        cameraDeg: store.camera,
        headDeg: store.head,
      });
      if (stale) observation.quality = 'no_sensor';
      else if (isCalibrating) observation.quality = 'calibrating';
      else if (
        store.phase === 'paused' ||
        (store.phase === 'ending' && this.endingFrom === 'paused')
      )
        observation.quality = 'paused';
      const sample = deriveWindow(store.mode, observation, {
        seq: ++this.sequence,
        elapsed_start_ms: this.cursor,
        duration_ms: duration,
        calibration_epoch: store.epoch,
      });
      if (sample.active_mode !== this.lastMode) {
        this.addEvent({
          type: 'mode_changed',
          data: {
            previous_mode: this.lastMode,
            current_mode: sample.active_mode,
            reason: sample.active_mode === 'none' ? 'sensor_lost' : 'sensor_restored',
          },
        });
        this.lastMode = sample.active_mode;
      }
      this.samples.push(sample);
      this.cursor += duration;
      const next = advanceAlerts(this.alerts, sample);
      this.alerts = next.state;
      this.commands(next.commands);
      const recent = [...useMeasurement.getState().recent, sample].slice(-120);
      useMeasurement.setState({ latest: sample, recent, elapsedMs: this.cursor });
    }
    useMeasurement.setState({
      pending: this.samples.length + this.events.length,
      memoryFull: this.cursor < target,
    });
  }

  private tick() {
    const store = useMeasurement.getState();
    if (!['active', 'paused', 'recalibrating'].includes(store.phase)) return;
    this.advance(Math.floor((performance.now() - this.origin) / 1000) * 1000);
    if (performance.now() - this.flushAt >= policy.transport.upload_every_ms) {
      this.flushAt = performance.now();
      void this.flush().catch(() => undefined);
    }
  }

  pause() {
    const phase = useMeasurement.getState().phase;
    if (phase !== 'active' && phase !== 'paused') return;
    const target = Math.floor(performance.now() - this.origin);
    this.advance(target);
    if (this.cursor < target) this.unavailableUntil = Math.max(this.unavailableUntil, target);
    this.close();
    this.addEvent({ type: phase === 'paused' ? 'resumed' : 'paused', data: {} }, target);
    useMeasurement.setState({ phase: phase === 'paused' ? 'active' : 'paused' });
  }

  recalibrate(mode?: Mode) {
    const store = useMeasurement.getState();
    if (!['active', 'paused'].includes(store.phase) || store.pending > 550) return;
    const target = Math.floor(performance.now() - this.origin);
    this.advance(target);
    if (this.cursor < target) {
      useMeasurement.setState({ error: '저장 연결을 확인한 후 기준을 재설정해 주세요.' });
      return;
    }
    this.close();
    const nextMode = mode ?? store.mode;
    const epoch = store.epoch + 1;
    this.addEvent({ type: 'calibration_started', data: { calibration_epoch: epoch } });
    this.calibrationUntil = this.cursor + 3000;
    useMeasurement.setState({ phase: 'recalibrating', epoch, mode: nextMode });
  }

  flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (useMeasurement.getState().missingSession)
      return Promise.reject(new Error('기록을 찾을 수 없어 저장할 수 없습니다.'));
    this.flushPromise = this.upload().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async upload() {
    const session = useMeasurement.getState().session;
    if (!session) return;
    useMeasurement.setState({ saving: true });
    try {
      while (this.samples.length || this.events.length) {
        if (this.samples.length) {
          const batch = this.samples.slice(0, 60);
          const receipt = await api.samples(session.id, batch as Sample[]);
          confirmedBatch(
            receipt,
            batch.length,
            batch[batch.length - 1].seq,
            'acknowledged_through_seq',
          );
          this.samples.splice(0, batch.length);
          useMeasurement.setState((s) => ({
            saved: s.saved + batch.length,
            pending: this.samples.length + this.events.length,
          }));
        }
        if (this.events.length) {
          const batch = this.events.slice(0, 60);
          const receipt = await api.events(session.id, batch);
          confirmedBatch(
            receipt,
            batch.length,
            batch[batch.length - 1].event_seq,
            'acknowledged_through_event_seq',
          );
          this.events.splice(0, batch.length);
          useMeasurement.setState({ pending: this.samples.length + this.events.length });
        }
      }
      useMeasurement.setState({ error: null });
    } catch (error) {
      if (isMissingSession(error)) this.markMissing();
      else useMeasurement.setState({ error: errorMessage(error) });
      throw error;
    } finally {
      if (!this.finishPromise || useMeasurement.getState().phase !== 'ending')
        useMeasurement.setState({ saving: false });
    }
  }

  finish(): Promise<Session | undefined> {
    if (this.finishPromise) return this.finishPromise;
    if (useMeasurement.getState().missingSession) return Promise.resolve(undefined);
    const session = useMeasurement.getState().session;
    if (
      !session ||
      !['active', 'paused', 'recalibrating', 'ending'].includes(useMeasurement.getState().phase)
    )
      return Promise.resolve(undefined);
    const operation = Promise.resolve().then(() => this.finishSession(session));
    const shared = operation.finally(() => {
      if (this.finishPromise === shared) this.finishPromise = null;
    });
    this.finishPromise = shared;
    return shared;
  }

  private async finishSession(session: Session) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.finalTarget === null) {
      const phase = useMeasurement.getState().phase;
      if (phase === 'active' || phase === 'paused' || phase === 'recalibrating')
        this.endingFrom = phase;
      this.finalTarget = Math.floor(performance.now() - this.origin);
    }
    this.advance(this.finalTarget);
    this.close();
    useMeasurement.setState({ phase: 'ending', saving: true });
    try {
      do {
        await this.flush();
        this.advance(this.finalTarget);
      } while (this.samples.length || this.events.length);
      const endedAt = new Date(Date.parse(session.started_at) + this.cursor).toISOString();
      const completed = await api.complete(session.id, {
        ended_at: endedAt,
        final_seq: this.sequence,
        final_event_seq: this.eventSequence,
      });
      if (
        !completed ||
        completed.id !== session.id ||
        completed.status !== 'completed' ||
        completed.ended_at !== endedAt ||
        completed.final_seq !== this.sequence ||
        completed.final_event_seq !== this.eventSequence
      )
        throw new Error('종료 확인에 실패했습니다. 다시 시도해 주세요.');
      useMeasurement.setState({
        phase: 'completed',
        session: completed,
        error: null,
        saving: false,
        memoryFull: false,
      });
      void Promise.resolve()
        .then(() => queryClient.invalidateQueries())
        .catch(() => undefined);
      return completed;
    } catch (error) {
      if (isMissingSession(error)) this.markMissing();
      else useMeasurement.setState({ phase: 'ending', error: errorMessage(error), saving: false });
      throw error;
    }
  }
}
export const measurement = new MeasurementController();
