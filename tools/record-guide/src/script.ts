/**
 * Recording script and export formats for the local recording tool (pure, no DOM).
 *
 * Times are milliseconds from the moment the recorder started (= time 0 of the laptop video).
 * Each step has an unlabelled preparation period (posture change) before the labelled hold, so
 * transitions never fall inside a scored segment.
 */

/** Labels known to tools/pose-compare/judge.py, plus `free` (unscripted, scored by side CVA only). */
export type SegmentLabel = 'upright' | 'chin_forward' | 'head_down' | 'combined' | 'turn' | 'free';

export interface ScriptStep {
  label: SegmentLabel;
  /** Labelled hold, seconds. */
  holdS: number;
  /** Shown big on screen and spoken at the start of the preparation period. */
  prompt: string;
  /** Free text kept in the segment files (e.g. strength). */
  note: string;
}

export interface PlannedSegment extends ScriptStep {
  index: number;
  prepStartMs: number;
  startMs: number;
  endMs: number;
}

export interface Plan {
  segments: PlannedSegment[];
  syncMs: number;
  endMs: number;
}

/** Sync beep (and screen flash) this long after the recorder starts, so both videos contain it. */
export const SYNC_MS = 2000;
/** Unlabelled time to change posture before each hold. */
export const PREP_MS = 3000;
/** Extra recording after the last hold. */
export const TAIL_MS = 1000;

const step = (label: SegmentLabel, holdS: number, prompt: string, note = ''): ScriptStep => ({
  label,
  holdS,
  prompt,
  note,
});

/** About 4 minutes 50 seconds. The first step must be upright (judge.py baseline). */
export const defaultScript: ScriptStep[] = [
  step('upright', 10, '등을 등받이에 붙이고 바른 자세로 화면을 보세요', '기준'),
  step('chin_forward', 10, '등은 붙인 채, 턱을 살짝 앞으로 내미세요', '살짝'),
  step('upright', 10, '바른 자세로 돌아오세요'),
  step('chin_forward', 10, '등은 붙인 채, 턱을 확실히 앞으로 내미세요', '확실히'),
  step('upright', 10, '바른 자세로 돌아오세요'),
  step('head_down', 10, '등은 붙인 채, 고개만 살짝 숙이세요', '살짝'),
  step('upright', 10, '바른 자세로 돌아오세요'),
  step('head_down', 10, '등은 붙인 채, 고개만 크게 숙이세요', '크게'),
  step('upright', 10, '바른 자세로 돌아오세요'),
  step('combined', 10, '등은 붙인 채, 턱을 내밀면서 고개도 숙이세요', '복합'),
  step('upright', 10, '바른 자세로 돌아오세요'),
  step('turn', 10, '고개를 좌우로 돌리며 말해 보세요', '돌리기·말하기'),
  step('free', 120, '이제 자유롭게, 평소처럼 타이핑하며 앉아 있으세요', '지시 없음 2분'),
];

export function planSchedule(
  script: readonly ScriptStep[] = defaultScript,
  syncMs = SYNC_MS,
): Plan {
  if (script.length === 0 || script[0].label !== 'upright')
    throw new Error('첫 단계는 upright(기준 자세)여야 해요');
  let t = syncMs + 1000;
  const segments = script.map((s, index) => {
    if (!(s.holdS > 0)) throw new Error(`${index + 1}번째 단계의 시간이 0 이하예요`);
    const prepStartMs = t;
    const startMs = prepStartMs + PREP_MS;
    const endMs = startMs + s.holdS * 1000;
    t = endMs;
    return { ...s, index, prepStartMs, startMs, endMs };
  });
  return { segments, syncMs, endMs: t + TAIL_MS };
}

export type Phase =
  | { phase: 'lead_in'; remainingMs: number }
  | { phase: 'prep' | 'hold'; segment: PlannedSegment; remainingMs: number }
  | { phase: 'done' };

export function phaseAt(plan: Plan, tMs: number): Phase {
  const first = plan.segments[0];
  if (tMs < first.prepStartMs) return { phase: 'lead_in', remainingMs: first.prepStartMs - tMs };
  for (const segment of plan.segments) {
    if (tMs < segment.startMs)
      return { phase: 'prep', segment, remainingMs: segment.startMs - tMs };
    if (tMs < segment.endMs) return { phase: 'hold', segment, remainingMs: segment.endMs - tMs };
  }
  return { phase: 'done' };
}

const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csvLine = (cells: (string | number)[]) => cells.map(csvCell).join(',');
const seconds = (ms: number) => Number((ms / 1000).toFixed(3));

/** `<id>.csv` for evaluate_segments.py: label,start,end,note in seconds of the laptop video. */
export function evaluateSegmentsCsv(plan: Plan): string {
  const rows = plan.segments
    .filter((s) => s.label !== 'free')
    .map((s) => csvLine([s.label, seconds(s.startMs), seconds(s.endMs), s.note]));
  return [csvLine(['label', 'start', 'end', 'note']), ...rows].join('\n') + '\n';
}

/**
 * `<id>.segments.json` for cva-label: times relative to the sync beep (beep = 0), because the side
 * phone started at a different moment. Give label_video.py the beep time in the side video.
 */
export function cvaSegmentsJson(plan: Plan): string {
  const items = plan.segments.map((s) => ({
    start_ms: s.startMs - plan.syncMs,
    end_ms: s.endMs - plan.syncMs,
    label: s.label,
    note: s.note,
  }));
  return JSON.stringify(items, null, 2) + '\n';
}

export interface LoggedPoint {
  x: number;
  y: number;
  confidence: number;
}

export interface LoggedFrame {
  tMs: number;
  width: number;
  height: number;
  quality: string;
  points: {
    nose: LoggedPoint | null;
    leftEar: LoggedPoint | null;
    rightEar: LoggedPoint | null;
    leftShoulder: LoggedPoint | null;
    rightShoulder: LoggedPoint | null;
  };
  /** 'ok' or a GuideIssue. */
  guide: string;
  shoulderWidth: number | null;
}

const POINTS = [
  ['nose', 'nose'],
  ['left_ear', 'leftEar'],
  ['right_ear', 'rightEar'],
  ['left_shoulder', 'leftShoulder'],
  ['right_shoulder', 'rightShoulder'],
] as const;

/**
 * `cache/<id>.landmarks.csv` in exactly the format evaluate_segments.py caches, so the evaluation
 * uses the landmarks the browser saw (same model build and timing as the service) instead of
 * re-running MediaPipe in Python on the recorded video.
 */
export function landmarksCsv(frames: readonly LoggedFrame[]): string {
  const header = ['t_ms', 'width', 'height', 'detected'];
  for (const [name] of POINTS) header.push(`${name}_x`, `${name}_y`, `${name}_c`);
  const rows = frames.map((f) => {
    const detected = f.quality === 'no_pose' ? 0 : 1;
    const cells: (string | number)[] = [Number(f.tMs.toFixed(1)), f.width, f.height, detected];
    for (const [, key] of POINTS) {
      const p = detected ? f.points[key] : null;
      if (p)
        cells.push(Number(p.x.toFixed(5)), Number(p.y.toFixed(5)), Number(p.confidence.toFixed(4)));
      else cells.push('', '', '');
    }
    return csvLine(cells);
  });
  return [csvLine(header), ...rows].join('\n') + '\n';
}

/** `<id>.guide.csv`: per analysed frame, frame quality, guide check and the script phase. */
export function guideCsv(frames: readonly LoggedFrame[], plan: Plan): string {
  const rows = frames.map((f) => {
    const p = phaseAt(plan, f.tMs);
    const label = p.phase === 'prep' || p.phase === 'hold' ? p.segment.label : '';
    return csvLine([
      Number(f.tMs.toFixed(1)),
      f.quality,
      f.guide,
      f.shoulderWidth === null ? '' : Number(f.shoulderWidth.toFixed(4)),
      p.phase,
      label,
    ]);
  });
  return (
    [csvLine(['t_ms', 'quality', 'guide', 'shoulder_width', 'phase', 'label']), ...rows].join(
      '\n',
    ) + '\n'
  );
}

/** Share of analysed frames inside the guide during each labelled hold. */
export function guideSummary(frames: readonly LoggedFrame[], plan: Plan) {
  return plan.segments.map((s) => {
    const inHold = frames.filter((f) => f.tMs >= s.startMs && f.tMs < s.endMs);
    const ok = inHold.filter((f) => f.guide === 'ok').length;
    return { index: s.index, label: s.label, note: s.note, frames: inHold.length, guideOk: ok };
  });
}

/** Participant/session file stem, e.g. P05_s1. Letters, digits, - and _ only. */
export function fileStem(participant: string, session: string): string {
  const clean = (v: string) => v.trim().replace(/[^A-Za-z0-9_-]/g, '');
  const p = clean(participant);
  const s = clean(session);
  if (!p) throw new Error('참가자 ID를 입력해 주세요 (예: P05)');
  return s ? `${p}_s${s.replace(/^s/i, '')}` : p;
}
