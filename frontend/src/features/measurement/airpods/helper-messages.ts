import { z } from 'zod';

/**
 * Messages between the browser and the local AirPods helper (protocol 1.0).
 * Mirrors docs/api/helper-message.schema.json; checked against docs/api/helper-contract-cases.json.
 * Raw motion never goes to the backend (AGENTS.md).
 */
const uuid = z.uuid();
const ms = z.number().min(0);
const rad = z.number().min(-Math.PI).max(Math.PI);
const rate = z.number().min(-100).max(100);

export const clientHelloSchema = z.strictObject({
  type: z.literal('client.hello'),
  protocol_version: z.literal('1.0'),
  pairing_token: z.string().min(32).max(128),
});

export const clockPingSchema = z.strictObject({
  type: z.literal('clock.ping'),
  ping_id: uuid,
  web_send_monotonic_ms: ms,
});

export const helperReadySchema = z.strictObject({
  type: z.literal('helper.ready'),
  protocol_version: z.literal('1.0'),
  stream_id: uuid,
  sample_rate_hz: z.number().gt(0).max(200),
  head_motion_available: z.boolean(),
  clock_unit: z.literal('ms'),
});

export const clockPongSchema = z.strictObject({
  type: z.literal('clock.pong'),
  ping_id: uuid,
  web_send_monotonic_ms: ms,
  helper_received_ms: ms,
  helper_sent_ms: ms,
});

export const motionSampleSchema = z.strictObject({
  type: z.literal('motion.sample'),
  stream_id: uuid,
  seq: z.number().int().min(1),
  helper_monotonic_ms: ms,
  pitch_rad: rad,
  roll_rad: rad,
  rotation_rate_rad_s: z.strictObject({ x: rate, y: rate, z: rate }),
});

export const sensorStatusSchema = z.strictObject({
  type: z.literal('sensor.status'),
  stream_id: uuid,
  status: z.enum(['connected', 'disconnected', 'motion_unavailable', 'permission_denied']),
  worn_state: z.enum(['worn', 'not_worn', 'unknown']),
});

export const helperErrorSchema = z.strictObject({
  type: z.literal('helper.error'),
  code: z.enum([
    'authentication_failed',
    'origin_rejected',
    'protocol_unsupported',
    'motion_unavailable',
    'rate_limited',
  ]),
});

/** What the browser accepts from the helper. */
export const helperToWebSchema = z.discriminatedUnion('type', [
  helperReadySchema,
  clockPongSchema,
  motionSampleSchema,
  sensorStatusSchema,
  helperErrorSchema,
]);

/** Every message of the protocol (used to check the shared fixture file). */
export const helperMessageSchema = z.discriminatedUnion('type', [
  clientHelloSchema,
  helperReadySchema,
  clockPingSchema,
  clockPongSchema,
  motionSampleSchema,
  sensorStatusSchema,
  helperErrorSchema,
]);

export type ClientHello = z.infer<typeof clientHelloSchema>;
export type ClockPing = z.infer<typeof clockPingSchema>;
export type HelperReady = z.infer<typeof helperReadySchema>;
export type ClockPong = z.infer<typeof clockPongSchema>;
export type MotionSample = z.infer<typeof motionSampleSchema>;
export type SensorStatus = z.infer<typeof sensorStatusSchema>;
export type HelperError = z.infer<typeof helperErrorSchema>;
export type HelperToWeb = z.infer<typeof helperToWebSchema>;

/** Semantic checks the JSON Schema cannot express (fixture WS-08). */
export function pongSemanticsValid(pong: ClockPong) {
  return pong.helper_sent_ms >= pong.helper_received_ms;
}

/**
 * Clock alignment from one ping/pong round trip (docs/api/airpods-websocket.md):
 * offset = ((t1 - t0) + (t2 - t3)) / 2, web_time = helper_time - offset.
 * `rtt` excludes the helper's own processing time; smaller is more trustworthy.
 */
export function clockEstimate(pong: ClockPong, webReceivedMs: number) {
  const t0 = pong.web_send_monotonic_ms;
  const t1 = pong.helper_received_ms;
  const t2 = pong.helper_sent_ms;
  const t3 = webReceivedMs;
  return { offset: (t1 - t0 + (t2 - t3)) / 2, rtt: t3 - t0 - (t2 - t1) };
}

export const helperErrorLabel: Record<HelperError['code'], string> = {
  authentication_failed: '페어링 코드가 맞지 않아요. 도우미 창의 코드를 다시 확인해 주세요.',
  origin_rejected: '이 주소는 도우미에서 허용되지 않았어요. 도우미 실행 옵션을 확인해 주세요.',
  protocol_unsupported: '도우미 버전이 맞지 않아요.',
  motion_unavailable: 'AirPods 머리 움직임을 받을 수 없어요. 지원 모델인지 확인해 주세요.',
  rate_limited: '연결 시도가 너무 잦아요. 잠시 뒤 다시 시도해 주세요.',
};
