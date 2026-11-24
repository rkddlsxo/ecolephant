import { describe, expect, it } from 'vitest';
import {
  PREP_MS,
  SYNC_MS,
  TAIL_MS,
  cvaSegmentsJson,
  defaultScript,
  evaluateSegmentsCsv,
  fileStem,
  guideCsv,
  guideSummary,
  landmarksCsv,
  phaseAt,
  planSchedule,
  type LoggedFrame,
} from './script';

const point = (x: number, y: number, confidence = 0.9) => ({ x, y, confidence });
const frame = (tMs: number, over: Partial<LoggedFrame> = {}): LoggedFrame => ({
  tMs,
  width: 1280,
  height: 720,
  quality: 'valid',
  points: {
    nose: point(0.5, 0.4),
    leftEar: point(0.55, 0.38),
    rightEar: point(0.45, 0.38),
    leftShoulder: point(0.7, 0.7),
    rightShoulder: point(0.3, 0.7),
  },
  guide: 'ok',
  shoulderWidth: 0.4,
  ...over,
});

describe('planSchedule', () => {
  it('puts an unlabelled preparation before every hold and starts after the sync beep', () => {
    const plan = planSchedule();
    const first = plan.segments[0];
    expect(first.prepStartMs).toBe(SYNC_MS + 1000);
    expect(first.startMs).toBe(first.prepStartMs + PREP_MS);
    for (let i = 1; i < plan.segments.length; i += 1) {
      expect(plan.segments[i].prepStartMs).toBe(plan.segments[i - 1].endMs);
      expect(plan.segments[i].startMs - plan.segments[i].prepStartMs).toBe(PREP_MS);
    }
    const last = plan.segments[plan.segments.length - 1];
    expect(plan.endMs).toBe(last.endMs + TAIL_MS);
  });

  it('keeps the default script under five minutes', () => {
    expect(planSchedule().endMs).toBeLessThan(5 * 60 * 1000);
  });

  it('rejects a script that does not start upright or has an empty hold', () => {
    expect(() => planSchedule([{ label: 'turn', holdS: 5, prompt: '', note: '' }])).toThrow();
    expect(() =>
      planSchedule([
        { label: 'upright', holdS: 10, prompt: '', note: '' },
        { label: 'turn', holdS: 0, prompt: '', note: '' },
      ]),
    ).toThrow();
  });
});

describe('phaseAt', () => {
  const plan = planSchedule();
  const s0 = plan.segments[0];
  const s1 = plan.segments[1];
  it('walks lead-in → prep → hold → next prep → done', () => {
    expect(phaseAt(plan, 0)).toEqual({ phase: 'lead_in', remainingMs: s0.prepStartMs });
    expect(phaseAt(plan, s0.prepStartMs)).toMatchObject({ phase: 'prep', segment: { index: 0 } });
    expect(phaseAt(plan, s0.startMs)).toMatchObject({ phase: 'hold', segment: { index: 0 } });
    expect(phaseAt(plan, s0.endMs)).toMatchObject({ phase: 'prep', segment: { index: 1 } });
    expect(phaseAt(plan, s1.startMs + 1)).toMatchObject({
      phase: 'hold',
      remainingMs: s1.endMs - s1.startMs - 1,
    });
    expect(phaseAt(plan, plan.endMs)).toEqual({ phase: 'done' });
  });
});

describe('segment files', () => {
  const plan = planSchedule();
  it('evaluate CSV: upright first, seconds of the laptop video, no free segment', () => {
    const lines = evaluateSegmentsCsv(plan).trim().split('\n');
    expect(lines[0]).toBe('label,start,end,note');
    expect(lines[1]).toBe(
      `upright,${plan.segments[0].startMs / 1000},${plan.segments[0].endMs / 1000},기준`,
    );
    expect(lines.some((l) => l.startsWith('free'))).toBe(false);
    expect(lines).toHaveLength(defaultScript.length); // header + all but free
    expect(lines).toContain(
      `turn,${plan.segments[11].startMs / 1000},${plan.segments[11].endMs / 1000},돌리기·말하기`,
    );
  });

  it('cva JSON: every segment, relative to the sync beep', () => {
    const items = JSON.parse(cvaSegmentsJson(plan));
    expect(items).toHaveLength(defaultScript.length);
    expect(items[0]).toEqual({
      start_ms: plan.segments[0].startMs - SYNC_MS,
      end_ms: plan.segments[0].endMs - SYNC_MS,
      label: 'upright',
      note: '기준',
    });
    expect(items[items.length - 1].label).toBe('free');
  });
});

describe('landmarksCsv', () => {
  it('matches the evaluate_segments.py cache header and blanks no_pose frames', () => {
    const csv = landmarksCsv([
      frame(100.04),
      frame(166.7, { quality: 'no_pose' }),
      frame(233.3, { points: { ...frame(0).points, nose: null } }),
    ]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      't_ms,width,height,detected,nose_x,nose_y,nose_c,left_ear_x,left_ear_y,left_ear_c,' +
        'right_ear_x,right_ear_y,right_ear_c,left_shoulder_x,left_shoulder_y,left_shoulder_c,' +
        'right_shoulder_x,right_shoulder_y,right_shoulder_c',
    );
    expect(lines[1]).toBe(
      '100,1280,720,1,0.5,0.4,0.9,0.55,0.38,0.9,0.45,0.38,0.9,0.7,0.7,0.9,0.3,0.7,0.9',
    );
    expect(lines[2]).toBe('166.7,1280,720,0' + ',,,'.repeat(5));
    expect(lines[3].startsWith('233.3,1280,720,1,,,,0.55')).toBe(true);
  });
});

describe('guide files', () => {
  const plan = planSchedule();
  const s0 = plan.segments[0];
  it('writes the phase and label for each frame', () => {
    const lines = guideCsv(
      [frame(0), frame(s0.startMs, { guide: 'too_far', shoulderWidth: 0.25 })],
      plan,
    )
      .trim()
      .split('\n');
    expect(lines[0]).toBe('t_ms,quality,guide,shoulder_width,phase,label');
    expect(lines[1]).toBe('0,valid,ok,0.4,lead_in,');
    expect(lines[2]).toBe(`${s0.startMs},valid,too_far,0.25,hold,upright`);
  });

  it('counts in-guide frames per hold only', () => {
    const summary = guideSummary(
      [frame(s0.prepStartMs), frame(s0.startMs), frame(s0.startMs + 100, { guide: 'move_left' })],
      plan,
    );
    expect(summary[0]).toEqual({ index: 0, label: 'upright', note: '기준', frames: 2, guideOk: 1 });
    expect(summary[1].frames).toBe(0);
  });
});

describe('fileStem', () => {
  it('builds P05_s1 and strips unsafe characters', () => {
    expect(fileStem('P05', '1')).toBe('P05_s1');
    expect(fileStem(' P05/.. ', 's2')).toBe('P05_s2');
    expect(fileStem('P06', '')).toBe('P06');
    expect(() => fileStem('  ', '1')).toThrow();
  });
});
