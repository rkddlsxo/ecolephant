import { describe, expect, it } from 'vitest';
import type { CameraFrame, CameraPoint } from './camera-features';
import { calibrationTips, defaultGuide, guideFit, guideLabel, type GuideIssue } from './guide-fit';

const p = (x: number, y: number, confidence = 0.95): CameraPoint => ({ x, y, confidence });

/** A person centred in a 1280×720 frame, shoulders 0.44 of the width apart. */
function frame(
  overrides: Partial<CameraFrame['landmarks']> = {},
  extra: Partial<CameraFrame> = {},
): CameraFrame {
  return {
    timestampMs: 1000,
    frameWidth: 1280,
    frameHeight: 720,
    quality: 'valid',
    landmarks: {
      nose: p(0.5, 0.38),
      leftEar: p(0.56, 0.36),
      rightEar: p(0.44, 0.36),
      leftShoulder: p(0.72, 0.75),
      rightShoulder: p(0.28, 0.75),
      ...overrides,
    },
    ...extra,
  };
}

/** Moves every landmark by (dx, dy). */
function shifted(dx: number, dy: number) {
  const f = frame();
  const move = (point: CameraPoint | null) =>
    point && { ...point, x: point.x + dx, y: point.y + dy };
  return frame({
    nose: move(f.landmarks.nose),
    leftEar: move(f.landmarks.leftEar),
    rightEar: move(f.landmarks.rightEar),
    leftShoulder: move(f.landmarks.leftShoulder),
    rightShoulder: move(f.landmarks.rightShoulder),
  });
}

describe('guide fit', () => {
  it('accepts a centred person at a normal distance', () => {
    const result = guideFit(frame());
    expect(result.fit).toBe(true);
    expect(result.shoulderWidth).toBeCloseTo(0.44, 6);
  });

  it('reports no person and missing points before geometry', () => {
    expect(guideFit(frame({}, { quality: 'no_pose' })).issue).toBe('no_person');
    expect(guideFit(frame({ leftEar: null })).issue).toBe('missing_points');
    expect(guideFit(frame({ rightShoulder: p(0.28, 0.75, 0.5) })).issue).toBe('missing_points');
    expect(guideFit(frame({}, { frameWidth: 0 })).issue).toBe('missing_points');
  });

  it('asks to come closer or sit back from the shoulder width', () => {
    const far = frame({ leftShoulder: p(0.62, 0.75), rightShoulder: p(0.38, 0.75) });
    const close = frame({ leftShoulder: p(0.85, 0.75), rightShoulder: p(0.15, 0.75) });
    expect(guideFit(far).issue).toBe('too_far');
    expect(guideFit(close).issue).toBe('too_close');
    // 2026-11-14: leaning in to ~0.56 of the width used to stay "fit" (max was 0.62).
    const leaning = frame({ leftShoulder: p(0.78, 0.75), rightShoulder: p(0.22, 0.75) });
    expect(guideFit(leaning).issue).toBe('too_close');
  });

  it("gives left/right in the person's own direction", () => {
    // Left of centre in the original frame = the camera's left = the person's right side.
    expect(guideFit(shifted(-0.15, 0)).issue).toBe('move_left');
    expect(guideFit(shifted(0.15, 0)).issue).toBe('move_right');
    expect(guideFit(shifted(0.1, 0)).fit).toBe(true);
  });

  it('checks vertical placement of shoulders and ears', () => {
    expect(guideFit(shifted(0, -0.25)).issue).toBe('move_down');
    expect(
      guideFit(frame({ leftShoulder: p(0.72, 0.98), rightShoulder: p(0.28, 0.98) })).issue,
    ).toBe('move_up');
    expect(guideFit(frame({ leftEar: p(0.56, 0.65), rightEar: p(0.44, 0.65) })).issue).toBe(
      'move_up',
    );
  });

  it('asks to level tilted shoulders', () => {
    const tilted = frame({ leftShoulder: p(0.72, 0.85), rightShoulder: p(0.28, 0.7) });
    expect(guideFit(tilted).issue).toBe('tilted');
    const slight = frame({ leftShoulder: p(0.72, 0.77), rightShoulder: p(0.28, 0.74) });
    expect(guideFit(slight).fit).toBe(true);
  });

  it('accepts a custom guide shape', () => {
    const strict = { ...defaultGuide, shoulderWidth: { min: 0.5, max: 0.7 } };
    expect(guideFit(frame(), strict).issue).toBe('too_far');
  });

  it('has a message for every issue and three posture tips', () => {
    const issues: GuideIssue[] = [
      'no_person',
      'missing_points',
      'too_far',
      'too_close',
      'move_left',
      'move_right',
      'move_down',
      'move_up',
      'tilted',
    ];
    for (const issue of issues) expect(guideLabel[issue].length).toBeGreaterThan(5);
    expect(calibrationTips).toHaveLength(3);
  });
});
