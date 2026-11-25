import { create } from 'zustand';
import {
  advancePitchCalibration,
  headFlexionDeg,
  initialPitchCalibration,
  median,
} from '@ecolephant/ai';
import type { Mode, Observation, PitchCalibrationState, PitchRestart } from '@ecolephant/ai';
import {
  clockEstimate,
  helperErrorLabel,
  helperToWebSchema,
  pongSemanticsValid,
  type ClientHello,
  type ClockPing,
  type HelperToWeb,
  type SensorStatus,
} from './helper-messages';

/**
 * Browser side of the local AirPods helper (docs/api/airpods-websocket.md, DEC-003).
 *
 * Development flag only for now: open the dev server with `?airpods=helper`. Without it nothing
 * here runs and real input stays webcam-only.
 *
 * Flow: connect to the loopback helper → `client.hello` with the pairing code shown by the
 * helper → `helper.ready` → clock ping/pong → `motion.sample` stream. Samples are moved onto the
 * browser's performance.now() clock, kept for 10 s, and turned into a head flexion angle against
 * a 3 s upright baseline taken for each wearing (ai/src/airpods-calibration.ts).
 *
 * The pitch axis sign is NOT verified yet (DEC-003): it is a setting (`?airpods-sign=-1`) until
 * the 5-minute axis check in tools/airpods-helper/README.md decides it.
 * Pitch samples stay in memory on this device and are never sent to the backend.
 */

// ------------------------------------------------------------------ dev flags

const flagKey = 'ecolephant.dev.airpods';
const signKey = 'ecolephant.dev.airpods-sign';
const urlKey = 'ecolephant.dev.airpods-url';

function stored(key: string): string | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string | null) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable; the URL flag still works on the page it was opened with.
  }
}

const currentSearch = () => (typeof window === 'undefined' ? '' : window.location.search);

/** `?airpods=helper` turns the AirPods helper path on for this tab, `?airpods=off` turns it off. */
export function airpodsHelperEnabled(
  search: string = currentSearch(),
  dev: boolean = import.meta.env.DEV,
): boolean {
  if (!dev) return false;
  const flag = new URLSearchParams(search).get('airpods');
  if (flag === 'helper') remember(flagKey, 'helper');
  if (flag === 'off') remember(flagKey, null);
  return (flag ?? stored(flagKey)) === 'helper';
}

/** Pitch sign until DEC-003 measures it: `?airpods-sign=-1` or `1` (default 1, unverified). */
export function airpodsSign(search: string = currentSearch()): 1 | -1 {
  const flag = new URLSearchParams(search).get('airpods-sign');
  if (flag === '1' || flag === '-1') remember(signKey, flag);
  return (flag ?? stored(signKey)) === '-1' ? -1 : 1;
}

export const defaultHelperUrl = 'ws://127.0.0.1:8765';

/** Helper address (`?airpods-url=ws://127.0.0.1:8765`). Only loopback addresses are accepted. */
export function helperUrl(search: string = currentSearch()): string {
  const flag = new URLSearchParams(search).get('airpods-url');
  if (flag) remember(urlKey, flag);
  return flag ?? stored(urlKey) ?? defaultHelperUrl;
}

export function isLoopbackHelperUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ pure helpers used by the controller

/**
 * Joins the camera part of a window with the AirPods angle.
 * A camera failure (no baseline, motion, low confidence) does not void the window when AirPods
 * give a valid angle in a mode that uses them: deriveWindow then reports `active_mode: airpods`.
 * Missing AirPods data is never filled in: headDeg stays null.
 */
export function combineObservation(
  mode: Mode,
  camera: Pick<Observation, 'cameraChange' | 'quality'>,
  headDeg: number | null,
): Observation {
  const head = mode === 'webcam' ? null : headDeg;
  const cameraUsed = mode !== 'airpods';
  const quality = head !== null ? undefined : cameraUsed ? camera.quality : 'no_sensor';
  return {
    cameraDeg: null,
    headDeg: head,
    cameraChange: cameraUsed ? camera.cameraChange : null,
    ...(quality ? { quality } : {}),
  };
}

/** Why measuring cannot start yet with real input, or null when it can. */
export function startProblem(
  mode: Mode,
  ready: { cameraBaseline: boolean; helperEnabled: boolean; airpodsBaseline: boolean },
): string | null {
  if (mode !== 'webcam' && !ready.helperEnabled)
    return '카메라를 켜고 표준 자세를 먼저 등록해 주세요.';
  if (mode !== 'airpods' && !ready.cameraBaseline)
    return '카메라를 켜고 표준 자세를 먼저 등록해 주세요.';
  if (mode !== 'webcam' && !ready.airpodsBaseline)
    return 'AirPods를 연결하고 표준 자세를 먼저 등록해 주세요.';
  return null;
}

// ------------------------------------------------------------------ connection

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export type LinkStatus =
  'off' | 'connecting' | 'authenticating' | 'syncing' | 'streaming' | 'sensor_lost' | 'error';

export interface AirPodsView {
  status: LinkStatus;
  error: string | null;
  sampleRateHz: number | null;
  sensor: SensorStatus['status'] | null;
  worn: SensorStatus['worn_state'] | null;
  calibrating: boolean;
  progress: number;
  lastRestart: PitchRestart | null;
  hasBaseline: boolean;
  /** Latest flexion against the baseline (degrees), for the status line only. */
  flexionDeg: number | null;
  /** Missing sequence numbers so far (reported, never filled in). */
  gaps: number;
  rttMs: number | null;
  sign: 1 | -1;
}

export const initialAirPodsView: AirPodsView = {
  status: 'off',
  error: null,
  sampleRateHz: null,
  sensor: null,
  worn: null,
  calibrating: false,
  progress: 0,
  lastRestart: null,
  hasBaseline: false,
  flexionDeg: null,
  gaps: 0,
  rttMs: null,
  sign: 1,
};

export const useAirPods = create<AirPodsView>(() => initialAirPodsView);

export const airpodsStatusLabel: Record<LinkStatus, string> = {
  off: '연결 안 됨',
  connecting: '도우미에 연결하는 중',
  authenticating: '페어링 확인 중',
  syncing: '시계 맞추는 중',
  streaming: '머리 움직임 받는 중',
  sensor_lost: 'AirPods 신호 없음',
  error: '연결 오류',
};

export const pitchRestartLabel: Record<PitchRestart, string> = {
  invalid: 'AirPods 값이 올바르지 않아 다시 측정해요.',
  gap: 'AirPods 신호가 끊겨 다시 측정해요.',
  unstable: '머리가 움직여서 다시 측정해요.',
  time_reversed: 'AirPods 시각이 맞지 않아 다시 측정해요.',
};

interface Options {
  factory?: SocketFactory;
  now?: () => number;
  randomId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

interface Sample {
  t: number;
  pitchRad: number;
}

const BUFFER_MS = 10_000;
const READY_TIMEOUT_MS = 5_000;
const FIRST_PINGS = 5;
const FIRST_PING_GAP_MS = 200;
const PING_EVERY_MS = 10_000;
const CLOCK_KEEP = 8;
/** A window needs at least half of the samples the helper said it would send (min 3). */
const MIN_WINDOW_SHARE = 0.5;

export class AirPodsLink {
  private socket: SocketLike | null = null;
  private token = '';
  private streamId: string | null = null;
  private sampleRateHz: number | null = null;
  private lastSeq = 0;
  private gaps = 0;
  private pending = new Map<string, number>();
  private clocks: { offset: number; rtt: number }[] = [];
  private samples: Sample[] = [];
  private calibration: PitchCalibrationState | null = null;
  private baselineRad: number | null = null;
  private sign: 1 | -1 = 1;
  private timers: unknown[] = [];
  private readonly factory: SocketFactory;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  constructor(options: Options = {}) {
    this.factory = options.factory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.now = options.now ?? (() => performance.now());
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  get calibrating() {
    return this.calibration !== null;
  }

  get hasBaseline() {
    return this.baselineRad !== null;
  }

  /** Clock offset in use (helper ms − web ms), or null before the first good pong. */
  get offset() {
    if (!this.clocks.length) return null;
    return this.clocks.reduce((best, c) => (c.rtt < best.rtt ? c : best)).offset;
  }

  /** Opens the connection. The pairing code is kept in memory only (never in the URL). */
  connect(url: string, pairingToken: string, sign: 1 | -1 = 1) {
    this.disconnect();
    this.sign = sign;
    if (!isLoopbackHelperUrl(url))
      return this.fail('도우미 주소는 ws://127.0.0.1 같은 이 컴퓨터 주소만 쓸 수 있어요.');
    const token = pairingToken.trim();
    if (token.length < 32 || token.length > 128)
      return this.fail('페어링 코드는 도우미 창에 나온 32자 이상의 코드예요.');
    this.token = token;
    this.publish({ ...initialAirPodsView, status: 'connecting', sign }, true);
    let socket: SocketLike;
    try {
      socket = this.factory(url);
    } catch {
      return this.fail('도우미에 연결할 수 없어요. 도우미가 실행 중인지 확인해 주세요.');
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      const hello: ClientHello = {
        type: 'client.hello',
        protocol_version: '1.0',
        pairing_token: this.token,
      };
      socket.send(JSON.stringify(hello));
      this.token = '';
      this.publish({ status: 'authenticating' });
      this.later(READY_TIMEOUT_MS, () => {
        if (this.socket === socket && !this.streamId) this.fail('도우미가 응답하지 않아요.');
      });
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onerror = () => {
      if (this.socket === socket)
        this.fail('도우미에 연결할 수 없어요. 도우미가 실행 중인지 확인해 주세요.');
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      const wasError = useAirPods.getState().status === 'error';
      this.reset();
      if (!wasError) this.publish({ status: 'off' });
    };
  }

  disconnect() {
    const socket = this.socket;
    this.reset();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000, 'client closed');
      } catch {
        // already closed
      }
    }
    this.publish({ ...initialAirPodsView, sign: this.sign }, true);
  }

  /** Start the 3 s upright baseline for this wearing (needs a live stream). */
  beginCalibration() {
    if (useAirPods.getState().status !== 'streaming') return false;
    this.calibration = initialPitchCalibration();
    this.publish({ calibrating: true, progress: 0, lastRestart: null });
    return true;
  }

  cancelCalibration() {
    this.calibration = null;
    this.publish({ calibrating: false, progress: 0, lastRestart: null });
  }

  /**
   * Head flexion for samples in [startMs, endMs) on the performance.now() clock, or null when
   * there is no baseline or too few samples. Too few samples is missing data, never "upright".
   */
  observe(startMs: number, endMs: number): { headDeg: number | null } {
    if (this.baselineRad === null || !this.sampleRateHz) return { headDeg: null };
    const inside = this.samples.filter((s) => s.t >= startMs && s.t < endMs);
    const expected = (this.sampleRateHz * (endMs - startMs)) / 1000;
    if (inside.length < Math.max(3, expected * MIN_WINDOW_SHARE)) return { headDeg: null };
    const flexion = headFlexionDeg(
      median(inside.map((s) => s.pitchRad)),
      this.baselineRad,
      this.sign,
    );
    return { headDeg: flexion.ok ? flexion.deg : null };
  }

  // ---------------------------------------------------------------- internals

  private receive(raw: unknown) {
    let data: unknown;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    const parsed = helperToWebSchema.safeParse(data);
    // Unknown or malformed messages are dropped (and never logged with their contents).
    if (!parsed.success) return;
    this.handle(parsed.data);
  }

  private handle(message: HelperToWeb) {
    switch (message.type) {
      case 'helper.error':
        return this.fail(helperErrorLabel[message.code]);
      case 'helper.ready':
        if (!message.head_motion_available) return this.fail(helperErrorLabel.motion_unavailable);
        this.streamId = message.stream_id;
        this.sampleRateHz = message.sample_rate_hz;
        this.lastSeq = 0;
        this.clocks = [];
        this.samples = [];
        this.publish({ status: 'syncing', sampleRateHz: message.sample_rate_hz, error: null });
        for (let i = 0; i < FIRST_PINGS; i += 1)
          this.later(i * FIRST_PING_GAP_MS, () => this.ping());
        this.every(PING_EVERY_MS);
        return;
      case 'clock.pong': {
        const sentAt = this.pending.get(message.ping_id);
        if (sentAt === undefined || sentAt !== message.web_send_monotonic_ms) return;
        this.pending.delete(message.ping_id);
        if (!pongSemanticsValid(message)) return;
        const estimate = clockEstimate(message, this.now());
        if (!(estimate.rtt >= 0)) return;
        this.clocks = [...this.clocks, estimate].slice(-CLOCK_KEEP);
        const best = this.clocks.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        this.publish({
          rttMs: Math.round(best.rtt * 10) / 10,
          ...(useAirPods.getState().status === 'syncing' ? { status: 'streaming' as const } : {}),
        });
        return;
      }
      case 'sensor.status': {
        if (message.stream_id !== this.streamId) return;
        const lost = message.status !== 'connected';
        if (lost) {
          // Earbuds out of the ear or motion off: the wearing angle may change, so the baseline
          // and buffered samples are dropped (additional feature ③).
          this.samples = [];
          this.baselineRad = null;
          if (this.calibration) this.calibration = initialPitchCalibration();
        }
        this.publish({
          sensor: message.status,
          worn: message.worn_state,
          hasBaseline: this.baselineRad !== null,
          ...(lost
            ? { status: 'sensor_lost' as const, flexionDeg: null }
            : useAirPods.getState().status === 'sensor_lost'
              ? { status: this.offset === null ? ('syncing' as const) : ('streaming' as const) }
              : {}),
        });
        return;
      }
      case 'motion.sample': {
        if (message.stream_id !== this.streamId) return;
        if (message.seq <= this.lastSeq) return; // duplicate or out of order: never overwrite the past
        if (this.lastSeq && message.seq > this.lastSeq + 1)
          this.gaps += message.seq - this.lastSeq - 1;
        this.lastSeq = message.seq;
        const offset = this.offset;
        if (offset === null) return; // not on the browser clock yet
        const t = message.helper_monotonic_ms - offset;
        const last = this.samples.at(-1);
        if (last && t <= last.t) return;
        const sample = { t, pitchRad: message.pitch_rad };
        this.samples = [...this.samples.filter((s) => s.t > t - BUFFER_MS), sample];
        this.calibrate(sample);
        const flexion =
          this.baselineRad === null
            ? null
            : headFlexionDeg(sample.pitchRad, this.baselineRad, this.sign);
        this.publish({
          gaps: this.gaps,
          flexionDeg: flexion && flexion.ok ? Math.round(flexion.deg * 10) / 10 : null,
        });
        return;
      }
    }
  }

  private calibrate(sample: Sample) {
    if (!this.calibration) return;
    const next = advancePitchCalibration(this.calibration, sample);
    if (next.status === 'done') {
      this.calibration = null;
      this.baselineRad = next.baselineRad;
      this.publish({ calibrating: false, progress: 1, hasBaseline: true, lastRestart: null });
      return;
    }
    this.calibration = next;
    this.publish({ progress: next.progress, lastRestart: next.lastRestart });
  }

  private ping() {
    const socket = this.socket;
    if (!socket || !this.streamId) return;
    const ping: ClockPing = {
      type: 'clock.ping',
      ping_id: this.randomId(),
      web_send_monotonic_ms: this.now(),
    };
    this.pending.set(ping.ping_id, ping.web_send_monotonic_ms);
    if (this.pending.size > 32) this.pending.delete(this.pending.keys().next().value!);
    socket.send(JSON.stringify(ping));
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(this.setTimer(fn, ms));
  }

  private every(ms: number) {
    const tick = () => {
      this.ping();
      this.later(ms, tick);
    };
    this.later(ms, tick);
  }

  private fail(message: string) {
    const socket = this.socket;
    this.reset();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000, 'client error');
      } catch {
        // already closed
      }
    }
    this.publish({ ...initialAirPodsView, status: 'error', error: message, sign: this.sign }, true);
  }

  /** Reconnects, sleep or stream changes drop the offset, buffer and baseline (contract). */
  private reset() {
    for (const id of this.timers) this.clearTimer(id);
    this.timers = [];
    this.socket = null;
    this.token = '';
    this.streamId = null;
    this.sampleRateHz = null;
    this.lastSeq = 0;
    this.gaps = 0;
    this.pending.clear();
    this.clocks = [];
    this.samples = [];
    this.calibration = null;
    this.baselineRad = null;
  }

  private publish(patch: Partial<AirPodsView>, replace = false) {
    if (replace) useAirPods.setState({ ...initialAirPodsView, ...patch }, true);
    else useAirPods.setState(patch);
  }
}

export const airpodsLink = new AirPodsLink();
