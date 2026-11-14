import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundProbe, backgroundMode, type ProbeReport } from './background-probe';

describe('backgroundMode', () => {
  afterEach(() => sessionStorage.clear());

  it('is on only with ?bg=timer on the dev server', () => {
    expect(backgroundMode('', true)).toBe('off');
    expect(backgroundMode('?bg=timer', true)).toBe('timer');
    expect(backgroundMode('?bg=timer', false)).toBe('off');
    expect(backgroundMode('?bg=other', true)).toBe('off');
  });

  it('remembers the flag for the tab until ?bg=off', () => {
    backgroundMode('?bg=timer', true);
    expect(backgroundMode('', true)).toBe('timer');
    expect(backgroundMode('', false)).toBe('off');
    backgroundMode('?bg=off', true);
    expect(backgroundMode('', true)).toBe('off');
  });
});

describe('BackgroundProbe', () => {
  afterEach(() => vi.useRealTimers());

  it('reports frame rate and window qualities per period, then starts a new period', () => {
    let now = 0;
    const reports: ProbeReport[] = [];
    const probe = new BackgroundProbe(
      () => now,
      (_message, report) => reports.push(report),
      () => true,
    );
    for (let i = 0; i < 12; i += 1) probe.frame(true, 4);
    probe.frame(false, 4);
    probe.window('no_sensor');
    probe.window('no_sensor');
    probe.window('valid');
    now = 10_000;
    const report = probe.report();
    expect(report).toMatchObject({
      seconds: 10,
      hidden: true,
      frames: 12,
      fps: 1.2,
      failedFrames: 1,
      windows: { no_sensor: 2, valid: 1 },
      videoReadyState: 4,
    });
    expect(reports).toHaveLength(1);
    now = 20_000;
    expect(probe.report()).toMatchObject({ frames: 0, windows: {}, seconds: 10 });
  });

  it('logs on a timer while running and logs only counts', () => {
    vi.useFakeTimers();
    const messages: string[] = [];
    const probe = new BackgroundProbe(
      () => Date.now(),
      (message, report) => messages.push(`${message} ${JSON.stringify(report)}`),
    );
    probe.start(10_000);
    expect(probe.running).toBe(true);
    probe.frame(true, 4);
    vi.advanceTimersByTime(10_000);
    probe.stop();
    expect(probe.running).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toMatch(/landmark|leftEar|confidence|\bx\b/);
  });
});
