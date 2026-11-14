import type { ActiveMode, PostureType } from './types';

/**
 * Alert wording and sound rules (additional feature ①, custom AirPods sound alert).
 *
 * Stage 1 is a short chime with a calm screen message; stage 2 adds a spoken sentence. The
 * browser plays sound on the current output device (AirPods only if they are the output),
 * and only after the user has pressed a button on the page. Wording avoids medical claims.
 */
export type AlertSound = 'chime' | 'voice';

export interface AlertMessage {
  title: string;
  body: string;
  sound: AlertSound;
  /** Text for speech synthesis on stage 2; null for stage 1. */
  speech: string | null;
}

export interface AlertSettings {
  /** 'chime' plays only the chime on both stages (no speech). */
  sound: 'chime_and_voice' | 'chime';
  /** Quiet hours in local time, "HH:MM". An interval may wrap past midnight. */
  quiet?: { start: string; end: string } | null;
}

export const defaultAlertSettings: AlertSettings = { sound: 'chime_and_voice', quiet: null };

const action: Record<PostureType | 'unknown', string> = {
  chin_forward: '턱을 살짝 당기고 머리를 어깨 위로 가져와 보세요.',
  head_down: '고개를 들고 화면을 눈높이로 맞춰 보세요.',
  combined: '고개를 들고 턱을 살짝 당겨 보세요.',
  unknown: '잠깐 자세를 확인해 보세요.',
};

const spoken: Record<PostureType | 'unknown', string> = {
  chin_forward: '머리가 앞으로 나와 있어요. 턱을 살짝 당겨 주세요.',
  head_down: '고개를 오래 숙이고 있어요. 화면을 눈높이로 올려 주세요.',
  combined: '고개가 숙여지고 앞으로 나와 있어요. 고개를 들고 턱을 당겨 주세요.',
  unknown: '자세를 한번 확인해 주세요.',
};

/**
 * AirPods-only mode cannot see the head moving forward, so a chin-forward or combined type
 * cannot come from it; the message stays on head drop and does not claim more.
 */
function effectiveType(type: PostureType | null, mode: ActiveMode): PostureType | 'unknown' {
  if (!type) return 'unknown';
  if (mode === 'airpods') return 'head_down';
  return type;
}

export function alertMessage(
  stage: 1 | 2,
  postureType: PostureType | null,
  activeMode: ActiveMode,
  settings: AlertSettings = defaultAlertSettings,
): AlertMessage {
  const type = effectiveType(postureType, activeMode);
  const voice = stage === 2 && settings.sound === 'chime_and_voice';
  return {
    title: stage === 1 ? '자세를 확인해 보세요' : '자세가 계속 무너져 있어요',
    body: action[type],
    sound: voice ? 'voice' : 'chime',
    speech: voice ? spoken[type] : null,
  };
}

function minutes(text: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`Quiet hours must look like HH:MM: ${text}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Quiet hours out of range: ${text}`);
  return hour * 60 + minute;
}

/** True when `minuteOfDay` (0..1439, local time) is inside the quiet hours. */
export function inQuietHours(minuteOfDay: number, quiet: AlertSettings['quiet']): boolean {
  if (!quiet) return false;
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return false;
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

/** Whether to play sound now. The screen alert and the record are kept either way. */
export function shouldPlaySound(
  minuteOfDay: number,
  settings: AlertSettings = defaultAlertSettings,
) {
  return !inQuietHours(minuteOfDay, settings.quiet);
}
