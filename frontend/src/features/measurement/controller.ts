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
import { api, errorMessage } from '../../api/client';
import type { EventPayload, Sample, SessionCreate, SessionEvent } from '../../api/client';
import { queryClient } from '../../api/query';
import { initialMeasurement, useMeasurement } from '../../state/measurement';
import { usePreferences } from '../../state/preferences';

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
  private finalTarget: number | null = null;
  private calibrationUntil: number | null = null;
  private starting: { body: SessionCreate; key: string; origin: number } | null = null;
  private flushAt = 0;
  private unavailableUntil = 0;

  async start(mode: Mode) {
    const current = useMeasurement.getState();
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
    useMeasurement.setState({ ...initialMeasurement, phase: 'starting', mode });
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
      else if (store.phase === 'paused') observation.quality = 'paused';
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
    this.advance(Math.floor(performance.now() - this.origin));
    this.close();
    this.addEvent({ type: phase === 'paused' ? 'resumed' : 'paused', data: {} });
    useMeasurement.setState({ phase: phase === 'paused' ? 'active' : 'paused' });
  }

  recalibrate(mode?: Mode) {
    const store = useMeasurement.getState();
    if (!['active', 'paused'].includes(store.phase) || store.pending > 550) return;
    this.advance(Math.floor(performance.now() - this.origin));
    this.close();
    const nextMode = mode ?? store.mode;
    const epoch = store.epoch + 1;
    this.addEvent({ type: 'calibration_started', data: { calibration_epoch: epoch } });
    this.calibrationUntil = this.cursor + 3000;
    useMeasurement.setState({ phase: 'recalibrating', epoch, mode: nextMode });
  }

  flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
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
          await api.samples(session.id, batch as Sample[]);
          this.samples.splice(0, batch.length);
          useMeasurement.setState((s) => ({ saved: s.saved + batch.length }));
        }
        if (this.events.length) {
          const batch = this.events.slice(0, 60);
          await api.events(session.id, batch);
          this.events.splice(0, batch.length);
        }
        useMeasurement.setState({ pending: this.samples.length + this.events.length });
      }
      useMeasurement.setState({ error: null });
    } catch (error) {
      useMeasurement.setState({ error: errorMessage(error) });
      throw error;
    } finally {
      useMeasurement.setState({ saving: false });
    }
  }

  async finish() {
    const session = useMeasurement.getState().session;
    if (
      !session ||
      !['active', 'paused', 'recalibrating', 'ending'].includes(useMeasurement.getState().phase)
    )
      return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.finalTarget ??= Math.floor(performance.now() - this.origin);
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
      useMeasurement.setState({
        phase: 'completed',
        session: completed,
        error: null,
        saving: false,
        memoryFull: false,
      });
      await queryClient.invalidateQueries();
      return completed;
    } catch (error) {
      useMeasurement.setState({ phase: 'ending', error: errorMessage(error), saving: false });
      throw error;
    }
  }
}
export const measurement = new MeasurementController();
