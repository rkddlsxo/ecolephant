import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: { create: vi.fn(), samples: vi.fn(), events: vi.fn(), complete: vi.fn() },
  invalidateQueries: vi.fn(),
}));
vi.mock('../../api/client', () => ({
  api: mocks.api,
  errorMessage: (error: Error) => error.message,
  isMissingSession: (error: unknown) =>
    error instanceof Error && error.message === 'missing session',
}));
vi.mock('../../api/query', () => ({ queryClient: { invalidateQueries: mocks.invalidateQueries } }));

import { measurement } from './controller';
import { initialMeasurement, useMeasurement } from '../../state/measurement';

describe('synthetic session flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    useMeasurement.setState({ ...initialMeasurement, scenario: 'normal' }, true);
    mocks.api.create.mockImplementation(async (body) => ({
      id: 'test-session',
      started_at: body.started_at,
    }));
    mocks.api.samples.mockImplementation(async (_id, batch) => ({
      accepted_count: batch.length,
      duplicate_count: 0,
      acknowledged_through_seq: batch.at(-1).seq,
    }));
    mocks.api.events.mockImplementation(async (_id, batch) => ({
      accepted_count: batch.length,
      duplicate_count: 0,
      acknowledged_through_event_seq: batch.at(-1).event_seq,
    }));
    mocks.api.complete.mockImplementation(async (_id, body) => ({
      id: 'test-session',
      status: 'completed',
      ...body,
    }));
    mocks.invalidateQueries.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('saves synthetic windows, keeps missing input unknown, and completes', async () => {
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(2000);
    useMeasurement.setState({ scenario: 'missing' });
    await vi.advanceTimersByTimeAsync(1000);
    measurement.pause();
    await measurement.finish();

    expect(mocks.api.create.mock.calls[0][0].data_source).toBe('demo');
    const samples = mocks.api.samples.mock.calls.flatMap((call) => call[1]);
    expect(samples.some((sample) => sample.quality === 'valid')).toBe(true);
    expect(
      samples.some(
        (sample) => sample.posture_level === 'unknown' && sample.camera_estimate_deg === null,
      ),
    ).toBe(true);
    expect(JSON.stringify(samples)).not.toContain('landmarks');
    expect(
      mocks.api.events.mock.calls
        .flatMap((call) => call[1])
        .some((event) => event.type === 'paused'),
    ).toBe(true);
    expect(mocks.api.complete).toHaveBeenCalledOnce();
    expect(useMeasurement.getState().phase).toBe('completed');
    // 저장 후 화면 값은 0으로 초기화
    expect(useMeasurement.getState()).toMatchObject({
      elapsedMs: 0,
      latest: null,
      recent: [],
      pending: 0,
      alert: null,
    });
  });

  it('stops the displayed measurement time while paused and continues after resuming', async () => {
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(3000);
    measurement.pause();
    const shown = () => useMeasurement.getState().elapsedMs - useMeasurement.getState().pausedMs;
    const atPause = shown();
    await vi.advanceTimersByTimeAsync(5000);
    expect(useMeasurement.getState().phase).toBe('paused');
    expect(shown()).toBe(atPause);
    measurement.pause();
    await vi.advanceTimersByTimeAsync(2000);
    expect(shown()).toBeGreaterThan(atPause);
    await measurement.finish();
  });

  it('recalibrates only from pause, then resumes measuring after the calibration window', async () => {
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(2000);
    measurement.recalibrate();
    expect(useMeasurement.getState().phase).toBe('active');

    measurement.pause();
    measurement.recalibrate();
    expect(useMeasurement.getState()).toMatchObject({ phase: 'recalibrating', epoch: 2 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(useMeasurement.getState().phase).toBe('active');
    await measurement.finish();
    const types = mocks.api.events.mock.calls.flatMap((call) => call[1]).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['paused', 'resumed', 'calibration_started', 'calibration_completed']),
    );
    expect(types.indexOf('resumed')).toBeLessThan(types.indexOf('calibration_started'));
  });

  it('refreshes open statistics and history views after each upload while measuring', async () => {
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(6000);
    expect(mocks.api.samples).toHaveBeenCalled();
    expect(useMeasurement.getState().phase).toBe('active');
    const call = mocks.invalidateQueries.mock.calls.find(([arg]) => arg?.predicate)?.[0];
    expect(call).toBeDefined();
    const refreshes = (key: unknown[]) => call.predicate({ queryKey: key });
    expect(refreshes(['statistics', {}, '', 'day'])).toBe(true);
    expect(refreshes(['sessions', {}, ''])).toBe(true);
    expect(refreshes(['policies'])).toBe(false);
    await measurement.finish();
  });

  it('keeps a failed completion retryable', async () => {
    mocks.api.complete.mockRejectedValueOnce(new Error('offline'));
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(measurement.finish()).rejects.toThrow('offline');
    expect(useMeasurement.getState().phase).toBe('ending');
    await measurement.finish();
    expect(mocks.api.complete).toHaveBeenCalledTimes(2);
    expect(mocks.api.complete.mock.calls[0][1]).toEqual(mocks.api.complete.mock.calls[1][1]);
    expect(useMeasurement.getState().phase).toBe('completed');
  });

  it('stops sampling and automatic retries when a background upload finds a deleted session', async () => {
    mocks.api.samples.mockRejectedValueOnce(new Error('missing session'));
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(5000);
    const interrupted = useMeasurement.getState();
    expect(interrupted.phase).toBe('ending');
    expect(interrupted.missingSession).toBe(true);
    expect(interrupted.pending).toBeGreaterThan(0);
    expect(interrupted.error).toContain('기록을 찾을 수 없어');
    const calls = mocks.api.samples.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(mocks.api.samples).toHaveBeenCalledTimes(calls);
    expect(useMeasurement.getState().pending).toBe(interrupted.pending);
    expect(useMeasurement.getState().elapsedMs).toBe(interrupted.elapsedMs);
    expect(measurement.reset()).toBe(false);
    await measurement.start('webcam');
    expect(mocks.api.create).toHaveBeenCalledTimes(1);
    expect(measurement.discardMissing()).toBe(true);
    expect(useMeasurement.getState().phase).toBe('idle');
    expect(useMeasurement.getState().pending).toBe(0);
    await measurement.start('webcam');
    await measurement.finish();
  });

  it.each(['samples', 'events', 'complete'] as const)(
    'retains a deleted session after %s fails during completion until explicit discard',
    async (operation) => {
      mocks.api[operation].mockRejectedValueOnce(new Error('missing session'));
      await measurement.start('webcam');
      await vi.advanceTimersByTimeAsync(1000);
      measurement.pause();
      await expect(measurement.finish()).rejects.toThrow('missing session');
      expect(useMeasurement.getState().phase).toBe('ending');
      expect(useMeasurement.getState().missingSession).toBe(true);
      expect(useMeasurement.getState().saving).toBe(false);
      expect(measurement.reset()).toBe(false);
      const calls = mocks.api[operation].mock.calls.length;
      await measurement.finish();
      expect(mocks.api[operation]).toHaveBeenCalledTimes(calls);
      expect(measurement.discardMissing()).toBe(true);
      expect(useMeasurement.getState().phase).toBe('idle');
    },
  );

  it('waits for a concurrent upload and completion to settle before allowing discard', async () => {
    let rejectUpload: (reason: Error) => void = () => undefined;
    mocks.api.samples.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        }),
    );
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(1000);
    const upload = measurement.flush().catch((error: unknown) => error);
    const finish = measurement.finish().catch((error: unknown) => error);
    await Promise.resolve();
    expect(measurement.discardMissing()).toBe(false);
    rejectUpload(new Error('missing session'));
    await Promise.all([upload, finish]);
    expect(useMeasurement.getState().missingSession).toBe(true);
    expect(useMeasurement.getState().pending).toBeGreaterThan(0);
    expect(mocks.api.complete).not.toHaveBeenCalled();
    expect(measurement.discardMissing()).toBe(true);
  });

  it('retains the selected test input when starting', async () => {
    useMeasurement.setState({ scenario: 'high' });
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(2000);
    const { scenario, latest } = useMeasurement.getState();
    await measurement.finish();
    expect(scenario).toBe('high');
    expect(latest?.posture_level).toBe('high');
  });

  it('discards a failed start identity when the account is reset', async () => {
    mocks.api.create.mockRejectedValueOnce(new Error('network failure'));
    await expect(measurement.start('webcam')).rejects.toThrow('network failure');
    const [firstBody, firstKey] = mocks.api.create.mock.calls[0];
    expect(measurement.reset()).toBe(true);
    await measurement.start('webcam');
    const [secondBody, secondKey] = mocks.api.create.mock.calls[1];
    expect(secondBody.client_session_id).not.toBe(firstBody.client_session_id);
    expect(secondKey).not.toBe(firstKey);
    await measurement.finish();
  });

  it('preserves a failed start identity for a same-account authentication recovery', async () => {
    mocks.api.create.mockRejectedValueOnce(new Error('network failure'));
    await expect(measurement.start('webcam')).rejects.toThrow('network failure');
    const [firstBody, firstKey] = mocks.api.create.mock.calls[0];
    expect(measurement.reset({ preservePendingStart: true })).toBe(true);
    await measurement.start('webcam');
    const [secondBody, secondKey] = mocks.api.create.mock.calls[1];
    expect(secondBody.client_session_id).toBe(firstBody.client_session_id);
    expect(secondKey).toBe(firstKey);
    await measurement.finish();
  });

  it('cannot reset a measurement while it is active', async () => {
    await measurement.start('webcam');
    expect(measurement.reset()).toBe(false);
    expect(useMeasurement.getState().phase).toBe('active');
    expect(useMeasurement.getState().session?.id).toBe('test-session');
    await measurement.finish();
  });

  it('retains samples when the server receipt does not acknowledge the whole batch', async () => {
    mocks.api.samples.mockImplementationOnce(async (_id, batch) => ({
      accepted_count: batch.length,
      duplicate_count: 0,
      acknowledged_through_seq: batch.at(-1).seq - 1,
    }));
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(measurement.finish()).rejects.toThrow();
    expect(useMeasurement.getState().saved).toBe(0);
    expect(useMeasurement.getState().pending).toBe(2);
    expect(mocks.api.complete).not.toHaveBeenCalled();
    await measurement.finish();
    expect(mocks.api.samples.mock.calls[1][1]).toEqual(mocks.api.samples.mock.calls[0][1]);
    expect(useMeasurement.getState().phase).toBe('completed');
  });

  it('retains events when the server receipt does not account for the whole batch', async () => {
    mocks.api.events.mockResolvedValueOnce({
      accepted_count: 0,
      duplicate_count: 0,
      acknowledged_through_event_seq: 0,
    });
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(2000);
    measurement.pause();
    await expect(measurement.finish()).rejects.toThrow();
    expect(useMeasurement.getState().pending).toBe(1);
    expect(mocks.api.complete).not.toHaveBeenCalled();
    await measurement.finish();
    expect(mocks.api.events.mock.calls[1][1]).toEqual(mocks.api.events.mock.calls[0][1]);
    expect(useMeasurement.getState().phase).toBe('completed');
  });

  it('accepts duplicate receipts after a response was lost and the same data is retried', async () => {
    mocks.api.samples.mockRejectedValueOnce(new Error('response lost'));
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(measurement.finish()).rejects.toThrow('response lost');
    mocks.api.samples.mockImplementationOnce(async (_id, batch) => ({
      accepted_count: 0,
      duplicate_count: batch.length,
      acknowledged_through_seq: batch.at(-1).seq,
    }));
    await measurement.finish();
    expect(mocks.api.samples.mock.calls[1][1]).toEqual(mocks.api.samples.mock.calls[0][1]);
    expect(useMeasurement.getState().phase).toBe('completed');
  });

  it('updates the remaining queue when event upload fails after sample upload', async () => {
    mocks.api.events.mockRejectedValueOnce(new Error('offline'));
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(2000);
    measurement.pause();
    await expect(measurement.flush()).rejects.toThrow('offline');
    expect(useMeasurement.getState().saved).toBe(2);
    expect(useMeasurement.getState().pending).toBe(1);
    await measurement.finish();
  });

  it('counts a queued pause event immediately', async () => {
    await measurement.start('webcam');
    measurement.pause();
    expect(useMeasurement.getState().pending).toBe(1);
    await measurement.finish();
  });

  it('shares an in-flight completion and remains saving until the server confirms it', async () => {
    let resolveCompletion!: (value: unknown) => void;
    mocks.api.complete.mockImplementationOnce(
      (_id, body) =>
        new Promise((resolve) => {
          resolveCompletion = () => resolve({ id: 'test-session', status: 'completed', ...body });
        }),
    );
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(1000);
    const first = measurement.finish();
    for (let i = 0; i < 20 && !resolveCompletion; i++) await Promise.resolve();
    const phaseWhileWaiting = useMeasurement.getState().phase;
    const savingWhileWaiting = useMeasurement.getState().saving;
    const second = measurement.finish();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const requestsWhileWaiting = mocks.api.complete.mock.calls.length;
    resolveCompletion(undefined);
    await Promise.allSettled([first, second]);
    expect(phaseWhileWaiting).toBe('ending');
    expect(savingWhileWaiting).toBe(true);
    expect(requestsWhileWaiting).toBe(1);
    expect(useMeasurement.getState().phase).toBe('completed');
  });

  it('keeps a completed session completed when refreshing views fails', async () => {
    mocks.invalidateQueries.mockRejectedValueOnce(new Error('refresh failed'));
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(measurement.finish()).resolves.toMatchObject({ status: 'completed' });
    await Promise.resolve();
    expect(useMeasurement.getState().phase).toBe('completed');
  });

  it('requires the completion response to match the session and final sequence', async () => {
    mocks.api.complete.mockImplementationOnce(async (_id, body) => ({
      id: 'different-session',
      status: 'completed',
      ...body,
    }));
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(measurement.finish()).rejects.toThrow();
    expect(useMeasurement.getState().phase).toBe('ending');
    await measurement.finish();
    expect(mocks.api.complete.mock.calls[1][1]).toEqual(mocks.api.complete.mock.calls[0][1]);
    expect(useMeasurement.getState().phase).toBe('completed');
  });

  it('keeps a paused interval invalid when finishing after an offline queue fills', async () => {
    mocks.api.samples.mockRejectedValue(new Error('offline'));
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(600_000);
    measurement.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(useMeasurement.getState().memoryFull).toBe(true);
    const sent: Array<{ seq: number; quality: string }> = [];
    mocks.api.samples.mockImplementation(async (_id, batch) => {
      sent.push(...batch);
      return {
        accepted_count: batch.length,
        duplicate_count: 0,
        acknowledged_through_seq: batch.at(-1).seq,
      };
    });
    await measurement.finish();
    expect(sent.find((sample) => sample.seq === 601)?.quality).toBe('paused');
  }, 15_000);

  it('records the actual pause time and treats an unrecorded backlog as unknown', async () => {
    mocks.api.samples.mockRejectedValue(new Error('offline'));
    await measurement.start('webcam');
    await vi.advanceTimersByTimeAsync(601_000);
    measurement.pause();
    const sent: Array<{ seq: number; quality: string }> = [];
    mocks.api.samples.mockImplementation(async (_id, batch) => {
      sent.push(...batch);
      return {
        accepted_count: batch.length,
        duplicate_count: 0,
        acknowledged_through_seq: batch.at(-1).seq,
      };
    });
    await measurement.finish();
    const events = mocks.api.events.mock.calls.flatMap((call) => call[1]);
    expect(events.find((event) => event.type === 'paused')?.elapsed_ms).toBe(601_000);
    expect(sent.find((sample) => sample.seq === 601)?.quality).toBe('no_sensor');
  }, 15_000);
});

describe('mode change reason', () => {
  it('records a lost sensor when fewer sensors remain and a restored one when more return', async () => {
    const { modeChangeReason } = await import('./controller');
    expect(modeChangeReason('combined', 'airpods')).toBe('sensor_lost');
    expect(modeChangeReason('combined', 'none')).toBe('sensor_lost');
    expect(modeChangeReason('airpods', 'none')).toBe('sensor_lost');
    expect(modeChangeReason('webcam', 'airpods')).toBe('sensor_lost');
    expect(modeChangeReason('none', 'airpods')).toBe('sensor_restored');
    expect(modeChangeReason('airpods', 'combined')).toBe('sensor_restored');
  });
});
