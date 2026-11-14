import { describe, expect, it } from 'vitest';
import { alertMessage, inQuietHours, shouldPlaySound } from './alert-messages';

describe('alert messages', () => {
  it('uses a chime first and a spoken sentence on stage 2', () => {
    const first = alertMessage(1, 'chin_forward', 'webcam');
    expect(first).toMatchObject({ sound: 'chime', speech: null });
    expect(first.body).toMatch(/턱/);
    const second = alertMessage(2, 'chin_forward', 'webcam');
    expect(second.sound).toBe('voice');
    expect(second.speech).toMatch(/앞으로/);
  });

  it('keeps stage 2 as a chime when voice is turned off', () => {
    expect(alertMessage(2, 'head_down', 'combined', { sound: 'chime' })).toMatchObject({
      sound: 'chime',
      speech: null,
    });
  });

  it('does not claim a forward head in AirPods-only mode', () => {
    const message = alertMessage(2, 'combined', 'airpods');
    expect(message.speech).toMatch(/숙이고/);
    expect(message.speech).not.toMatch(/앞으로/);
  });

  it('has a neutral message when the posture type is unknown', () => {
    expect(alertMessage(1, null, 'webcam').body).toMatch(/확인/);
  });

  it('never uses diagnostic wording', () => {
    for (const type of ['chin_forward', 'head_down', 'combined', null] as const)
      for (const stage of [1, 2] as const) {
        const text = JSON.stringify(alertMessage(stage, type, 'combined'));
        expect(text).not.toMatch(/진단|질환|치료/);
      }
  });

  it('handles quiet hours, including past midnight', () => {
    const night = { start: '22:00', end: '07:00' };
    expect(inQuietHours(23 * 60, night)).toBe(true);
    expect(inQuietHours(6 * 60 + 59, night)).toBe(true);
    expect(inQuietHours(7 * 60, night)).toBe(false);
    expect(inQuietHours(12 * 60, { start: '12:00', end: '13:00' })).toBe(true);
    expect(inQuietHours(13 * 60, { start: '12:00', end: '13:00' })).toBe(false);
    expect(inQuietHours(0, null)).toBe(false);
    expect(shouldPlaySound(23 * 60, { sound: 'chime', quiet: night })).toBe(false);
    expect(() => inQuietHours(0, { start: '25:00', end: '07:00' })).toThrow();
  });
});
