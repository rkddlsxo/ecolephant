import { describe, expect, it } from 'vitest';
import { cameraModelResultSchema } from '../model-adapter';
import {
  POSE_INDEX,
  draftQualityOptions,
  toCameraModelResult,
  type MotionSample,
  type RawLandmark,
} from './pose-result';

const frame = { frameWidth: 1280, frameHeight: 720 };

/** 33-point pose with only the contract points filled in. */
function pose(
  overrides: Partial<Record<keyof typeof POSE_INDEX, RawLandmark>> = {},
  shiftX = 0,
): RawLandmark[] {
  const points: RawLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 0.1,
  }));
  const base: Record<keyof typeof POSE_INDEX, RawLandmark> = {
    nose: { x: 0.5 + shiftX, y: 0.35, z: 0, visibility: 0.99 },
    leftEar: { x: 0.56 + shiftX, y: 0.33, z: 0, visibility: 0.95 },
    rightEar: { x: 0.44 + shiftX, y: 0.33, z: 0, visibility: 0.95 },
    leftShoulder: { x: 0.65 + shiftX, y: 0.6, z: 0, visibility: 0.98 },
    rightShoulder: { x: 0.35 + shiftX, y: 0.6, z: 0, visibility: 0.98 },
  };
  for (const [name, index] of Object.entries(POSE_INDEX) as [keyof typeof POSE_INDEX, number][])
    points[index] = overrides[name] ?? base[name];
  return points;
}

function run(input: RawLandmark[] | undefined, timestampMs = 1000, history: MotionSample[] = []) {
  return toCameraModelResult({ timestampMs, ...frame, pose: input }, history);
}

describe('pose result conversion', () => {
  it('maps MediaPipe indices to the contract and keeps original (unmirrored) coordinates', () => {
    const { result } = run(pose());
    expect(result.quality).toBe('valid');
    expect(result.landmarks.leftShoulder).toEqual({ x: 0.65, y: 0.6, confidence: 0.98 });
    expect(result.landmarks.rightEar).toEqual({ x: 0.44, y: 0.33, confidence: 0.95 });
    expect(result).toMatchObject({ timestampMs: 1000, ...frame });
    expect(cameraModelResultSchema.safeParse(result).success).toBe(true);
  });

  it('reports no_pose with all points null when nothing is detected', () => {
    for (const input of [undefined, []]) {
      const { result, history } = run(input);
      expect(result.quality).toBe('no_pose');
      expect(Object.values(result.landmarks).every((point) => point === null)).toBe(true);
      expect(history).toEqual([]);
      expect(cameraModelResultSchema.safeParse(result).success).toBe(true);
    }
  });

  it('accepts a single head point (nose or one ear)', () => {
    const lowEar = { x: 0.5, y: 0.3, visibility: 0.2 };
    const { result } = run(pose({ leftEar: lowEar, rightEar: lowEar }));
    expect(result.quality).toBe('valid');
    const earOnly = run(pose({ nose: lowEar, rightEar: lowEar }));
    expect(earOnly.result.quality).toBe('valid');
  });

  it('never upgrades low-confidence required points to valid', () => {
    const weak = { x: 0.35, y: 0.6, visibility: 0.69 };
    const { result } = run(pose({ rightShoulder: weak }));
    expect(result.quality).toBe('low_confidence');
    expect(result.landmarks.rightShoulder?.confidence).toBe(0.69);
    expect(cameraModelResultSchema.safeParse(result).success).toBe(true);
  });

  it('treats the confidence threshold as inclusive', () => {
    const edge = { x: 0.35, y: 0.6, visibility: 0.7 };
    expect(run(pose({ rightShoulder: edge })).result.quality).toBe('valid');
  });

  it('drops out-of-frame points instead of clamping them', () => {
    const outside = { x: 1.08, y: 0.6, visibility: 0.9 };
    const { result } = run(pose({ leftShoulder: outside }));
    expect(result.landmarks.leftShoulder).toBeNull();
    expect(result.quality).toBe('low_confidence');
    expect(cameraModelResultSchema.safeParse(result).success).toBe(true);
  });

  it('uses the lower of visibility and presence and clamps to 0..1', () => {
    const { result } = run(
      pose({
        nose: { x: 0.5, y: 0.35, visibility: 1.2, presence: 0.8 },
        leftEar: { x: 0.56, y: 0.33 },
      }),
    );
    expect(result.landmarks.nose?.confidence).toBe(0.8);
    expect(result.landmarks.leftEar?.confidence).toBe(0);
  });

  it('flags motion against a reference at least the baseline old', () => {
    const first = run(pose(), 1000);
    expect(first.result.quality).toBe('valid');
    // 0.06 of frame width = 0.2 shoulder widths in 300 ms
    const moved = run(pose({}, 0.06), 1300, first.history);
    expect(moved.result.quality).toBe('motion');
    expect(cameraModelResultSchema.safeParse(moved.result).success).toBe(true);
  });

  it('ignores per-frame jitter and small shifts', () => {
    const first = run(pose(), 1000);
    // Too recent to be a reference: no motion judgment yet.
    expect(run(pose({}, 0.06), 1100, first.history).result.quality).toBe('valid');
    // Old enough, but only 0.1 shoulder widths.
    expect(run(pose({}, 0.03), 1300, first.history).result.quality).toBe('valid');
  });

  it('discards references older than the max gap', () => {
    const first = run(pose(), 1000);
    const later = run(pose({}, 0.1), 1000 + draftQualityOptions.motionMaxGapMs + 1, first.history);
    expect(later.result.quality).toBe('valid');
    expect(later.history).toHaveLength(1);
  });

  it('measures motion in pixels, not raw normalized units', () => {
    // Same normalized vertical shift is larger relative to shoulders in a tall frame.
    const tall = { frameWidth: 720, frameHeight: 1280 };
    const at = (t: number, dy: number, h: MotionSample[]) =>
      toCameraModelResult(
        {
          timestampMs: t,
          ...tall,
          pose: pose({
            nose: { x: 0.5, y: 0.35 + dy, visibility: 0.99 },
            leftEar: { x: 0.56, y: 0.33 + dy, visibility: 0.95 },
            rightEar: { x: 0.44, y: 0.33 + dy, visibility: 0.95 },
          }),
        },
        h,
      );
    const first = at(1000, 0, []);
    // dy 0.03 of 1280 px = 38 px; shoulder width 0.3 * 720 = 216 px → 0.18 widths
    expect(at(1300, 0.03, first.history).result.quality).toBe('motion');
  });

  it('resets motion history after a low-quality frame', () => {
    const first = run(pose(), 1000);
    const lost = run(undefined, 1100, first.history);
    expect(lost.history).toEqual([]);
    expect(run(pose({}, 0.1), 1300, lost.history).result.quality).toBe('valid');
  });
});
