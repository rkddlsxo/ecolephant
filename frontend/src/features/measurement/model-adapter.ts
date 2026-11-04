import { z } from 'zod';

const point = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

/** Local-only image coordinates. They must never be sent to the backend. */
export const cameraModelResultSchema = z
  .object({
    timestampMs: z.number().finite().nonnegative(),
    frameWidth: z.number().int().positive(),
    frameHeight: z.number().int().positive(),
    quality: z.enum(['valid', 'no_pose', 'low_confidence', 'motion']),
    landmarks: z
      .object({
        nose: point.nullable(),
        leftEar: point.nullable(),
        rightEar: point.nullable(),
        leftShoulder: point.nullable(),
        rightShoulder: point.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((result, context) => {
    const { nose, leftEar, rightEar, leftShoulder, rightShoulder } = result.landmarks;
    if (
      result.quality === 'valid' &&
      (!leftShoulder || !rightShoulder || !(nose || leftEar || rightEar))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Valid results require head and shoulder points.',
      });
    }
  });

export type CameraModelResult = z.infer<typeof cameraModelResultSchema>;

/** Adapter is intentionally unimplemented until the ML team chooses a model. */
export interface PostureModelAdapter {
  load(): Promise<void>;
  analyze(video: HTMLVideoElement, timestampMs: number): Promise<CameraModelResult>;
  close(): void | Promise<void>;
}

export const postureModelAdapter: PostureModelAdapter | null = null;
