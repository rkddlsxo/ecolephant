import type { CameraModelResult, PostureModelAdapter } from '../model-adapter';
import { cameraModelResultSchema } from '../model-adapter';
import {
  draftQualityOptions,
  toCameraModelResult,
  type MotionSample,
  type QualityOptions,
  type RawLandmark,
} from './pose-result';

/** Self-hosted assets (see scripts/pose-assets.mjs). Nothing is fetched from third parties. */
export const POSE_MODELS = ['lite', 'full', 'heavy'] as const;
export type PoseModelVariant = (typeof POSE_MODELS)[number];

export const POSE_ASSETS = {
  wasmBase: '/mediapipe/wasm',
  model: (variant: PoseModelVariant = 'lite') => `/mediapipe/pose_landmarker_${variant}.task`,
} as const;

/** Minimal surface of MediaPipe PoseLandmarker that the adapter uses. */
export interface PoseLandmarkerLike {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): { landmarks: RawLandmark[][] };
  close(): void;
}

export type LandmarkerFactory = (
  delegate: 'GPU' | 'CPU',
  variant: PoseModelVariant,
) => Promise<PoseLandmarkerLike>;

export interface MediaPipeAdapterOptions {
  factory?: LandmarkerFactory;
  quality?: QualityOptions;
  /** Default lite. full/heavy are for accuracy comparison (ADR-0004). */
  variant?: PoseModelVariant;
  /** Debug only: all 33 raw points of the first pose, for local drawing. Never store or send. */
  onRawPose?: (pose: readonly RawLandmark[] | undefined) => void;
}

/** Default factory: lazy import keeps the 13 MB WASM out of the initial bundle. */
export const mediaPipeFactory: LandmarkerFactory = async (delegate, variant) => {
  const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(POSE_ASSETS.wasmBase);
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: POSE_ASSETS.model(variant), delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    outputSegmentationMasks: false,
  });
};

export class VideoNotReadyError extends Error {
  constructor() {
    super('Video frame is not ready for pose analysis.');
    this.name = 'VideoNotReadyError';
  }
}

export function createMediaPipeAdapter(
  options: MediaPipeAdapterOptions = {},
): PostureModelAdapter & { readonly delegate: 'GPU' | 'CPU' | null } {
  const factory = options.factory ?? mediaPipeFactory;
  const quality = options.quality ?? draftQualityOptions;
  const variant = options.variant ?? 'lite';
  let landmarker: PoseLandmarkerLike | null = null;
  let loading: Promise<void> | null = null;
  let delegate: 'GPU' | 'CPU' | null = null;
  let generation = 0;
  let history: MotionSample[] = [];
  let lastModelTimestamp = -Infinity;

  const reset = () => {
    history = [];
    lastModelTimestamp = -Infinity;
  };

  return {
    get delegate() {
      return delegate;
    },

    load() {
      if (landmarker) return Promise.resolve();
      if (loading) return loading;
      const request = generation;
      loading = (async () => {
        let created: PoseLandmarkerLike;
        let used: 'GPU' | 'CPU' = 'GPU';
        try {
          created = await factory('GPU', variant);
        } catch {
          used = 'CPU';
          created = await factory('CPU', variant);
        }
        if (request !== generation) {
          created.close();
          return;
        }
        landmarker = created;
        delegate = used;
        reset();
      })().finally(() => {
        if (request === generation) loading = null;
      });
      return loading;
    },

    async analyze(video, timestampMs): Promise<CameraModelResult> {
      if (!landmarker) throw new Error('Pose model is not loaded.');
      const frameWidth = video.videoWidth;
      const frameHeight = video.videoHeight;
      if (video.readyState < 2 || !(frameWidth > 0) || !(frameHeight > 0))
        throw new VideoNotReadyError();
      // MediaPipe VIDEO mode rejects non-increasing timestamps; the returned value stays the call time.
      const modelTimestamp = Math.max(Math.round(timestampMs), lastModelTimestamp + 1);
      lastModelTimestamp = modelTimestamp;
      const output = landmarker.detectForVideo(video, modelTimestamp);
      options.onRawPose?.(output.landmarks[0]);
      const converted = toCameraModelResult(
        { timestampMs, frameWidth, frameHeight, pose: output.landmarks[0] },
        history,
        quality,
      );
      history = converted.history;
      return cameraModelResultSchema.parse(converted.result);
    },

    close() {
      generation += 1;
      loading = null;
      landmarker?.close();
      landmarker = null;
      delegate = null;
      reset();
    },
  };
}
