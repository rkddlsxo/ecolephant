import { expect, it } from 'vitest';
import type { Metrics } from '../../api/client';
import {
  bucketModes,
  correctionRatio,
  meanCorrection,
  sessionLength,
  statusLabel,
  summaryView,
} from './format';

const started_at = '2026-11-01T08:00:00Z';

it('formats session length from start and end times', () => {
  expect(sessionLength({ started_at, ended_at: '2026-11-01T08:12:03Z', status: 'completed' })).toBe(
    '12분 3초',
  );
  expect(sessionLength({ started_at, ended_at: '2026-11-01T09:30:00Z', status: 'completed' })).toBe(
    '1시간 30분',
  );
});

it('does not invent a length without an end time', () => {
  expect(sessionLength({ started_at, ended_at: null, status: 'active' })).toBe('진행 중');
  expect(sessionLength({ started_at, ended_at: null, status: 'abandoned' })).toBe(
    '길이 알 수 없음',
  );
  expect(sessionLength({ started_at, ended_at: '2026-11-01T07:00:00Z', status: 'completed' })).toBe(
    '길이 알 수 없음',
  );
});

it('shows correction metrics only when there were alerts', () => {
  const base = { first_stage_alert_count: 0, corrected_alert_count: 0, mean_correction_ms: null };
  expect(correctionRatio(base as Metrics)).toBeNull();
  expect(meanCorrection(base as Metrics)).toBe('—');
  const alerted = {
    first_stage_alert_count: 3,
    corrected_alert_count: 2,
    mean_correction_ms: 7500,
  };
  expect(correctionRatio(alerted as Metrics)).toBe('2/3회');
  expect(meanCorrection(alerted as Metrics)).toBe('0분 7초');
});

it('separates abandoned sessions from in-progress ones', () => {
  expect(statusLabel('completed')).toBe('완료');
  expect(statusLabel('active')).toBe('미완료');
  expect(statusLabel('abandoned')).toBe('중단');
});

it('builds summary lines with estimated angle and empty values instead of invented ones', () => {
  const metrics = {
    valid_duration_ms: 60000,
    normal_duration_ms: 30000,
    caution_duration_ms: 10000,
    high_duration_ms: 20000,
    forward_head_suspected_ms: 5000,
    mean_display_angle_deg: 12.34,
    within_range_percent: 50,
    first_stage_alert_count: 2,
    corrected_alert_count: 1,
    unknown_correction_count: 1,
    mean_correction_ms: 3000,
  };
  const view = summaryView(metrics);
  expect(view.tiles.map((t) => t.value)).toEqual(['1분 0초', '50.0%', '2회']);
  expect(view.tiles[2]).toMatchObject({ caption: '알림 후 자세 변화 1/2회' });
  expect(view.total).toBe(60000);
  expect(view.parts.map((p) => p.ms)).toEqual([30000, 10000, 20000]);
  expect(view.details).toEqual([
    ['평균 각도(추정)', '12.3°'],
    ['앞쪽 쏠림 의심', '0분 5초'],
    ['알림 후 자세 변화', '1/2회'],
    ['평균 변화 시간', '0분 3초'],
  ]);
  const empty = summaryView({
    ...metrics,
    valid_duration_ms: 0,
    first_stage_alert_count: 0,
    corrected_alert_count: 0,
    mean_correction_ms: null,
  });
  expect(empty.details[0]).toEqual(['평균 각도(추정)', '—']);
  expect(empty.tiles[2]).toMatchObject({ caption: undefined });
  expect(empty.details[2]).toEqual(['알림 후 자세 변화', '—']);
});

it('labels the modes used in a timeline bucket', () => {
  expect(bucketModes(['webcam', 'airpods'])).toBe('웹캠 · AirPods');
  expect(bucketModes([])).toBe('—');
});

it('explains why a session summary is split by the sensor actually used', async () => {
  const { summaryTitle } = await import('./format');
  expect(summaryTitle('combined', 'combined')).toBe('웹캠 + AirPods');
  expect(summaryTitle('combined', 'airpods')).toBe('AirPods (카메라 끊김 구간)');
  expect(summaryTitle('combined', 'webcam')).toBe('웹캠 (AirPods 끊김 구간)');
  expect(summaryTitle('webcam', 'webcam')).toBe('웹캠');
});
