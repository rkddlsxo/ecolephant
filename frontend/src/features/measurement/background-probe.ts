/**
 * Development-only probe for background measurement (DEC-010, 2026-11-11).
 *
 * Open the dev server with `?bg=timer` to keep the camera on when the tab is hidden and log,
 * every 10 s, how many frames were analysed and how the 1 s windows were judged. Without the
 * flag (and in production builds) nothing changes: the camera still stops on a hidden tab.
 *
 * Only counts and quality names are logged. No frames, landmarks or features.
 */
export type BackgroundMode = 'off' | 'timer';

const storageKey = 'ecolephant.dev.bg';

function stored(): string | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function remember(value: string | null) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (value) sessionStorage.setItem(storageKey, value);
    else sessionStorage.removeItem(storageKey);
  } catch {
    // Storage can be unavailable; the URL flag still works on the page it was opened with.
  }
}

/**
 * `?bg=timer` turns the probe on for this browser tab (kept across page moves in session
 * storage), `?bg=off` turns it off again. Always 'off' outside the dev server.
 */
export function backgroundMode(
  search: string = typeof window === 'undefined' ? '' : window.location.search,
  dev: boolean = import.meta.env.DEV,
): BackgroundMode {
  if (!dev) return 'off';
  const flag = new URLSearchParams(search).get('bg');
  if (flag === 'timer') remember('timer');
  if (flag === 'off') remember(null);
  return (flag ?? stored()) === 'timer' ? 'timer' : 'off';
}

export interface ProbeReport {
  /** Seconds since the previous report (wall clock, so throttled timers show up here). */
  seconds: number;
  hidden: boolean;
  /** Hidden-state changes since the previous report. */
  visibilityChanges: number;
  frames: number;
  fps: number;
  failedFrames: number;
  windows: Record<string, number>;
  videoReadyState: number | null;
}

type Log = (message: string, report: ProbeReport) => void;

export class BackgroundProbe {
  private frames = 0;
  private failed = 0;
  private windows: Record<string, number> = {};
  private visibilityChanges = 0;
  private videoReadyState: number | null = null;
  private since: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onVisibility = () => {
    this.visibilityChanges += 1;
    this.log(`[bg-probe] ${document.hidden ? 'hidden' : 'visible'}`, this.snapshot(false));
  };

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly log: Log = (message, report) => console.info(message, report),
    private readonly isHidden: () => boolean = () =>
      typeof document !== 'undefined' && document.hidden,
  ) {
    this.since = now();
  }

  get running() {
    return this.timer !== null;
  }

  start(intervalMs = 10_000) {
    if (this.timer) return;
    this.reset();
    this.timer = setInterval(() => this.report(), intervalMs);
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.onVisibility);
  }

  frame(ok: boolean, videoReadyState: number | null = null) {
    if (ok) this.frames += 1;
    else this.failed += 1;
    this.videoReadyState = videoReadyState;
  }

  window(quality: string) {
    this.windows[quality] = (this.windows[quality] ?? 0) + 1;
  }

  /** Builds the report and starts a new period. */
  report(): ProbeReport {
    const report = this.snapshot(true);
    this.log('[bg-probe] 10s', report);
    return report;
  }

  private snapshot(resetAfter: boolean): ProbeReport {
    const seconds = Math.max(0.001, (this.now() - this.since) / 1000);
    const report: ProbeReport = {
      seconds: Math.round(seconds * 10) / 10,
      hidden: this.isHidden(),
      visibilityChanges: this.visibilityChanges,
      frames: this.frames,
      fps: Math.round((this.frames / seconds) * 10) / 10,
      failedFrames: this.failed,
      windows: { ...this.windows },
      videoReadyState: this.videoReadyState,
    };
    if (resetAfter) this.reset();
    return report;
  }

  private reset() {
    this.frames = 0;
    this.failed = 0;
    this.windows = {};
    this.visibilityChanges = 0;
    this.since = this.now();
  }
}

export const backgroundProbe = new BackgroundProbe();
