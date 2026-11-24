import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AirPodsLink,
  airpodsHelperEnabled,
  airpodsSign,
  combineObservation,
  isLoopbackHelperUrl,
  startProblem,
  useAirPods,
  type SocketLike,
} from './airpods-link';
import { clockEstimate, helperMessageSchema, pongSemanticsValid } from './helper-messages';

const STREAM = '10000000-0000-4000-8000-000000000001';
const TOKEN = 'a'.repeat(32);

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onSend: ((message: Record<string, unknown>) => void) | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) {
    const message = JSON.parse(data);
    this.sent.push(message);
    this.onSend?.(message);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function setup() {
  let now = 1000;
  const sockets: FakeSocket[] = [];
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 0;
  let pingId = 0;
  const link = new AirPodsLink({
    factory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => now,
    randomId: () => `20000000-0000-4000-8000-${String(++pingId).padStart(12, '0')}`,
    setTimer: (fn, ms) => {
      const id = ++nextId;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      now = next.at;
      next.fn();
    }
    now = until;
  };
  return {
    link,
    sockets,
    advance,
    setNow: (value: number) => (now = value),
    getNow: () => now,
  };
}

const ready = (rate = 20) => ({
  type: 'helper.ready',
  protocol_version: '1.0',
  stream_id: STREAM,
  sample_rate_hz: rate,
  head_motion_available: true,
  clock_unit: 'ms',
});

/** Fake helper: clock = web clock + 5000 ms, 2 ms each way, 1 ms processing. */
function autoPong(socket: FakeSocket, getNow: () => number, setNow: (v: number) => void) {
  socket.onSend = (ping) => {
    if (ping.type !== 'clock.ping') return;
    const t0 = ping.web_send_monotonic_ms as number;
    setNow(getNow() + 5);
    socket.receive({
      type: 'clock.pong',
      ping_id: ping.ping_id,
      web_send_monotonic_ms: t0,
      helper_received_ms: t0 + 2 + 5000,
      helper_sent_ms: t0 + 3 + 5000,
    });
  };
}

function connected(rate = 20) {
  const ctx = setup();
  ctx.link.connect('ws://127.0.0.1:8765', TOKEN);
  const socket = ctx.sockets[0];
  socket.open();
  autoPong(socket, ctx.getNow, ctx.setNow);
  socket.receive(ready(rate));
  ctx.advance(1000); // first pings go out and are answered
  return { ...ctx, socket };
}

let seq = 0;
function sample(socket: FakeSocket, webMs: number, pitchRad: number) {
  socket.receive({
    type: 'motion.sample',
    stream_id: STREAM,
    seq: ++seq,
    helper_monotonic_ms: webMs + 5000,
    pitch_rad: pitchRad,
    roll_rad: 0,
    rotation_rate_rad_s: { x: 0, y: 0, z: 0 },
  });
}

function stream(
  socket: FakeSocket,
  from: number,
  to: number,
  pitch: (t: number) => number,
  hz = 20,
) {
  for (let t = from; t < to; t += 1000 / hz) sample(socket, t, pitch(t));
}

beforeEach(() => {
  seq = 0;
  useAirPods.setState(useAirPods.getInitialState(), true);
  sessionStorage.clear();
});

describe('helper messages', () => {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../../docs/api/helper-contract-cases.json'), 'utf8'),
  ) as { cases: { id: string; valid: boolean; semantics_valid: boolean; value: unknown }[] };

  it('accept and reject the shared fixture cases like the JSON Schema', () => {
    for (const c of fixture.cases)
      expect(helperMessageSchema.safeParse(c.value).success, c.id).toBe(c.valid);
  });

  it('flag a pong whose helper times run backwards (WS-08)', () => {
    const ws08 = fixture.cases.find((c) => c.id === 'WS-08')!;
    const pong = helperMessageSchema.parse(ws08.value);
    expect(pong.type === 'clock.pong' && pongSemanticsValid(pong)).toBe(false);
  });

  it('estimate the clock offset with the contract formula', () => {
    // WS-03: t0=1000, t1=5000, t2=5001, received t3=1003 → offset 3999, rtt 2
    const estimate = clockEstimate(
      {
        type: 'clock.pong',
        ping_id: STREAM,
        web_send_monotonic_ms: 1000,
        helper_received_ms: 5000,
        helper_sent_ms: 5001,
      },
      1003,
    );
    expect(estimate).toEqual({ offset: 3999, rtt: 2 });
  });
});

describe('AirPods link', () => {
  it('sends the pairing code first, then reaches streaming after the clock sync', () => {
    const { socket, link } = connected();
    expect(socket.sent[0].type).toBe('client.hello');
    expect(socket.sent.filter((m) => m.type === 'clock.ping')).toHaveLength(5);
    expect(useAirPods.getState()).toMatchObject({ status: 'streaming', sampleRateHz: 20 });
    expect(link.offset).toBeCloseTo(5000, 5);
  });

  it('puts the pairing code only in client.hello, never in the URL', () => {
    const ctx = setup();
    const urls: string[] = [];
    const link = new AirPodsLink({
      factory: (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        ctx.sockets.push(socket);
        return socket;
      },
    });
    link.connect('ws://127.0.0.1:8765', TOKEN);
    ctx.sockets[0].open();
    expect(urls[0]).not.toContain(TOKEN);
    expect(ctx.sockets[0].sent[0]).toEqual({
      type: 'client.hello',
      protocol_version: '1.0',
      pairing_token: TOKEN,
    });
  });

  it('refuses non-loopback addresses and short codes', () => {
    const { link } = setup();
    link.connect('ws://192.168.0.10:8765', TOKEN);
    expect(useAirPods.getState().status).toBe('error');
    link.connect('ws://127.0.0.1:8765', 'short');
    expect(useAirPods.getState().error).toMatch(/32자/);
    expect(isLoopbackHelperUrl('ws://localhost:8765')).toBe(true);
    expect(isLoopbackHelperUrl('http://127.0.0.1:8765')).toBe(false);
  });

  it('shows helper errors and times out without helper.ready', () => {
    const ctx = setup();
    ctx.link.connect('ws://127.0.0.1:8765', TOKEN);
    ctx.sockets[0].open();
    ctx.sockets[0].receive({ type: 'helper.error', code: 'authentication_failed' });
    expect(useAirPods.getState()).toMatchObject({ status: 'error' });
    expect(useAirPods.getState().error).toMatch(/페어링 코드/);
    ctx.link.connect('ws://127.0.0.1:8765', TOKEN);
    ctx.sockets[1].open();
    ctx.advance(5001);
    expect(useAirPods.getState().error).toMatch(/응답하지/);
  });

  it('ignores samples before the clock sync, from other streams, and out of order', () => {
    const { socket, link } = connected();
    link.beginCalibration();
    socket.receive({
      type: 'motion.sample',
      stream_id: '30000000-0000-4000-8000-000000000003',
      seq: 99,
      helper_monotonic_ms: 9000,
      pitch_rad: 1,
      roll_rad: 0,
      rotation_rate_rad_s: { x: 0, y: 0, z: 0 },
    });
    sample(socket, 2000, 0);
    seq -= 1; // same seq again: dropped
    sample(socket, 2050, 1);
    expect(useAirPods.getState().calibrating).toBe(true);
    expect(useAirPods.getState().progress).toBe(0);
  });

  it('takes a 3 s baseline and reports flexion against it with the configured sign', () => {
    const { socket, link } = connected();
    expect(link.beginCalibration()).toBe(true);
    stream(socket, 2000, 5100, () => 0.1);
    expect(useAirPods.getState()).toMatchObject({ hasBaseline: true, calibrating: false });
    const down = 0.1 + (20 * Math.PI) / 180;
    stream(socket, 6000, 7000, () => down);
    expect(link.observe(6000, 7000).headDeg).toBeCloseTo(20, 5);
    // Opposite sign: the same tilt reads as "head back", which flexion clamps to 0.
    const flipped = setup();
    flipped.link.connect('ws://127.0.0.1:8765', TOKEN, -1);
    expect(useAirPods.getState().sign).toBe(-1);
  });

  it('returns null for a window with too few samples instead of a normal angle', () => {
    const { socket, link } = connected();
    link.beginCalibration();
    stream(socket, 2000, 5100, () => 0);
    stream(socket, 6000, 6200, () => 0.3); // 4 samples where 20 Hz promised 20
    expect(link.observe(6000, 7000).headDeg).toBeNull();
    expect(link.observe(9000, 10000).headDeg).toBeNull();
  });

  it('drops the baseline when the earbuds disconnect', () => {
    const { socket, link } = connected();
    link.beginCalibration();
    stream(socket, 2000, 5100, () => 0);
    expect(link.hasBaseline).toBe(true);
    socket.receive({
      type: 'sensor.status',
      stream_id: STREAM,
      status: 'disconnected',
      worn_state: 'not_worn',
    });
    expect(link.hasBaseline).toBe(false);
    expect(useAirPods.getState().status).toBe('sensor_lost');
    socket.receive({
      type: 'sensor.status',
      stream_id: STREAM,
      status: 'connected',
      worn_state: 'worn',
    });
    expect(useAirPods.getState().status).toBe('streaming');
  });

  it('counts sequence gaps without filling them in', () => {
    const { socket } = connected();
    sample(socket, 2000, 0);
    seq += 3;
    sample(socket, 2200, 0);
    expect(useAirPods.getState().gaps).toBe(3);
  });

  it('restarts the baseline when the head moves during calibration', () => {
    const { socket, link } = connected();
    link.beginCalibration();
    stream(socket, 2000, 3000, () => 0);
    sample(socket, 3050, (10 * Math.PI) / 180);
    expect(useAirPods.getState().lastRestart).toBe('unstable');
    expect(link.hasBaseline).toBe(false);
  });

  it('forgets everything when the socket closes', () => {
    const { socket, link } = connected();
    link.beginCalibration();
    stream(socket, 2000, 5100, () => 0);
    socket.onclose?.({});
    expect(link.hasBaseline).toBe(false);
    expect(link.offset).toBeNull();
    expect(useAirPods.getState().status).toBe('off');
  });
});

describe('controller helpers', () => {
  const change = { forward: 0.08, drop: 0, noseDrop: null };

  it('combine camera and AirPods by mode', () => {
    expect(combineObservation('webcam', { cameraChange: change }, 20)).toEqual({
      cameraDeg: null,
      headDeg: null,
      cameraChange: change,
    });
    expect(combineObservation('combined', { cameraChange: change }, 20)).toMatchObject({
      headDeg: 20,
      cameraChange: change,
    });
    // Camera failed but AirPods are fine: the window falls back to AirPods instead of unknown.
    expect(
      combineObservation('combined', { cameraChange: null, quality: 'motion' }, 20),
    ).not.toHaveProperty('quality');
    // AirPods missing in combined: the camera result (and its failure) stays.
    expect(
      combineObservation('combined', { cameraChange: null, quality: 'motion' }, null),
    ).toMatchObject({
      quality: 'motion',
    });
    // AirPods-only without AirPods data is no_sensor, never normal.
    expect(combineObservation('airpods', { cameraChange: change }, null)).toMatchObject({
      quality: 'no_sensor',
      cameraChange: null,
    });
  });

  it('say what is missing before measuring can start', () => {
    const all = { cameraBaseline: true, helperEnabled: true, airpodsBaseline: true };
    expect(
      startProblem('webcam', { ...all, helperEnabled: false, airpodsBaseline: false }),
    ).toBeNull();
    expect(startProblem('combined', { ...all, helperEnabled: false })).toMatch(/카메라/);
    expect(startProblem('airpods', { ...all, cameraBaseline: false })).toBeNull();
    expect(startProblem('combined', { ...all, airpodsBaseline: false })).toMatch(/AirPods/);
    expect(startProblem('combined', all)).toBeNull();
  });

  it('read the dev flags only on the dev server', () => {
    expect(airpodsHelperEnabled('?airpods=helper', false)).toBe(false);
    expect(airpodsHelperEnabled('?airpods=helper', true)).toBe(true);
    expect(airpodsHelperEnabled('', true)).toBe(true); // remembered for the tab
    expect(airpodsHelperEnabled('?airpods=off', true)).toBe(false);
    expect(airpodsSign('?airpods-sign=-1')).toBe(-1);
    expect(airpodsSign('')).toBe(-1);
    expect(airpodsSign('?airpods-sign=1')).toBe(1);
  });
});
