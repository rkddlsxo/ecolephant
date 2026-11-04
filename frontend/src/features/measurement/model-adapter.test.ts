import { describe, expect, it } from 'vitest';
import { cameraModelResultSchema } from './model-adapter';

const point = { x: 0.5, y: 0.4, confidence: 0.9 };
const valid = {
  timestampMs: 200,
  frameWidth: 1280,
  frameHeight: 720,
  quality: 'valid',
  landmarks: {
    nose: point,
    leftEar: null,
    rightEar: null,
    leftShoulder: point,
    rightShoulder: point,
  },
};

describe('camera model handoff', () => {
  it('accepts normalized local landmarks and unavailable poses', () => {
    expect(cameraModelResultSchema.safeParse(valid).success).toBe(true);
    expect(
      cameraModelResultSchema.safeParse({
        timestampMs: 201,
        frameWidth: 1280,
        frameHeight: 720,
        quality: 'no_pose',
        landmarks: {
          nose: null,
          leftEar: null,
          rightEar: null,
          leftShoulder: null,
          rightShoulder: null,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects a valid result without enough visible points', () => {
    expect(
      cameraModelResultSchema.safeParse({
        ...valid,
        landmarks: { ...valid.landmarks, leftShoulder: null },
      }).success,
    ).toBe(false);
  });

  it('rejects invalid coordinates and unexpected image payloads', () => {
    expect(
      cameraModelResultSchema.safeParse({
        ...valid,
        landmarks: { ...valid.landmarks, nose: { ...point, x: 2 } },
      }).success,
    ).toBe(false);
    expect(cameraModelResultSchema.safeParse({ ...valid, frame: 'not-allowed' }).success).toBe(
      false,
    );
  });
});
