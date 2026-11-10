import { create } from 'zustand';
import {
  advanceCalibration,
  cameraFeatures,
  cameraObservation,
  initialCalibration,
  summarizeCameraWindow,
} from '@ecolephant/ai';
import type {
  CalibrationRestart,
  CalibrationState,
  CameraBaseline,
  FeatureResult,
  Observation,
} from '@ecolephant/ai';
import type { PostureModelAdapter } from './model-adapter';
import { createMediaPipeAdapter, VideoNotReadyError } from './pose/mediapipe-adapter';

/**
 * Real webcam input for measurement (ECOLEPHANT-11).
 *
 * video → pose adapter (≤15 fps) → `cameraFeatures` → 3 s calibration or a short local buffer
 * → `observe(start, end)` summarises one 1 s window into change values for `deriveWindow`.
 *
 * Landmarks and features never leave this module: the controller only receives change values
 * (or a failure reason), and nothing here talks to the network.
 */

export type PipelineStatus = 'off' | 'loading' | 'running' | 'error';

export interface PipelineView {
  status: PipelineStatus;
  delegate: 'GPU' | 'CPU' | null;
  /** Analysed frames per second over the last second (null until measured). */
  fps: number | null;
  calibrating: boolean;
  /** 0..1 progress of the current stable segment. */
  progress: number;
  lastRestart: CalibrationRestart | null;
  hasBaseline: boolean;
  error: string | null;
}

export const initialPipelineView: PipelineView = {
  status: 'off',
  delegate: null,
  fps: null,
  calibrating: false,
  progress: 0,
  lastRestart: null,
  hasBaseline: false,
  error: null,
};

export const useCameraPipeline = create<PipelineView>(() => initialPipelineView);

/** On-screen guidance for a calibration restart. */
export const restartLabel: Record<CalibrationRestart, string> = {
  no_pose: '사람이 보이지 않아요. 화면 안에 앉아 주세요.',
  low_confidence: '얼굴과 어깨가 잘 보이지 않아요. 조명을 확인해 주세요.',
  motion: '움직임이 있어요. 잠시 가만히 있어 주세요.',
  missing_points: '양쪽 귀와 어깨가 모두 화면에 보이게 해 주세요.',
  degenerate: '카메라와 너무 멀어요. 조금 가까이 앉아 주세요.',
  unstable: '자세가 흔들렸어요. 편한 자세로 가만히 있어 주세요.',
  gap: '분석이 잠시 끊겼어요. 다시 측정할게요.',
  time_reversed: '시간 정보가 맞지 않아 다시 측정할게요.',
};

interface Frame {
  t: number;
  result: FeatureResult;
}

export interface CameraPipelineOptions {
  createAdapter?: () => PostureModelAdapter & { readonly delegate?: 'GPU' | 'CPU' | null };
  now?: () => number;
  /** Analysis interval. 1000/15 matches the dev overlay cap and the measured ~14 fps. */
  intervalMs?: number;
  /** How long analysed frames are kept for window summaries. */
  bufferMs?: number;
}

export class CameraPipeline {
  private adapter: (PostureModelAdapter & { readonly delegate?: 'GPU' | 'CPU' | null }) | null =
    null;
  private loading: Promise<void> | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private frames: Frame[] = [];
  private calibration: CalibrationState | null = null;
  private baseline: CameraBaseline | null = null;
  private analysed: number[] = [];
  private viewAt = 0;
  private readonly createAdapter;
  private readonly now;
  private readonly intervalMs;
  private readonly bufferMs;

  constructor(options: CameraPipelineOptions = {}) {
    this.createAdapter = options.createAdapter ?? (() => createMediaPipeAdapter());
    this.now = options.now ?? (() => performance.now());
    this.intervalMs = options.intervalMs ?? 1000 / 15;
    this.bufferMs = options.bufferMs ?? 10_000;
  }

  get hasBaseline() {
    return this.baseline !== null;
  }

  get calibrating() {
    return this.calibration !== null;
  }

  /** Connect a playing video element, or `null` to stop analysing (camera off, page left). */
  attach(video: HTMLVideoElement | null) {
    if (video === this.video) return;
    this.halt();
    this.video = video;
    if (video) void this.run();
  }

  /** Starts a new 3 s calibration. The previous baseline stays until the new one is stored. */
  beginCalibration() {
    this.calibration = initialCalibration();
    this.publish({ calibrating: true, progress: 0, lastRestart: null }, true);
  }

  cancelCalibration() {
    this.calibration = null;
    this.publish({ calibrating: false, progress: 0, lastRestart: null }, true);
  }

  /**
   * Camera part of an Observation for frames analysed in [startMs, endMs) on the
   * `performance.now()` clock. Never reports a normal posture for missing data.
   */
  observe(startMs: number, endMs: number): Pick<Observation, 'cameraChange' | 'quality'> {
    if (!this.baseline) return { cameraChange: null, quality: 'no_sensor' };
    const results = this.frames
      .filter((frame) => frame.t >= startMs && frame.t < endMs)
      .map((frame) => frame.result);
    return cameraObservation(summarizeCameraWindow(results, this.baseline));
  }

  /** Forget the baseline and buffered frames (tests, sign-out). */
  reset() {
    this.halt();
    this.video = null;
    this.baseline = null;
    this.calibration = null;
    useCameraPipeline.setState(initialPipelineView, true);
  }

  private halt() {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.frames = [];
    this.analysed = [];
    if (this.adapter || this.loading) this.publish({ status: 'off', fps: null }, true);
  }

  private async run() {
    const run = this.generation;
    try {
      if (!this.adapter) {
        this.publish({ status: 'loading', error: null }, true);
        const adapter = this.createAdapter();
        this.loading = adapter.load();
        await this.loading;
        this.loading = null;
        if (run !== this.generation) {
          adapter.close();
          return;
        }
        this.adapter = adapter;
      }
      this.publish(
        { status: 'running', delegate: this.adapter.delegate ?? null, error: null },
        true,
      );
      this.schedule(run, 0);
    } catch {
      this.loading = null;
      if (run === this.generation)
        this.publish(
          {
            status: 'error',
            error: 'AI 모델을 불러오지 못했어요. npm run pose:assets 실행 여부를 확인해 주세요.',
          },
          true,
        );
    }
  }

  private schedule(run: number, delay: number) {
    this.timer = setTimeout(() => void this.step(run), delay);
  }

  private async step(run: number) {
    if (run !== this.generation || !this.adapter || !this.video) return;
    const started = this.now();
    try {
      const frame = await this.adapter.analyze(this.video, started);
      if (run !== this.generation) return;
      this.accept(cameraFeatures(frame), frame.timestampMs);
    } catch (error) {
      // A frame that is not ready (VideoNotReadyError) or fails is skipped. Too few analysed
      // frames in a window make that window no_sensor; nothing is filled in as normal.
      void (error instanceof VideoNotReadyError);
    }
    if (run !== this.generation) return;
    const elapsed = this.now() - started;
    this.schedule(run, Math.max(0, this.intervalMs - elapsed));
  }

  private accept(result: FeatureResult, t: number) {
    this.analysed.push(t);
    this.analysed = this.analysed.filter((time) => time > t - 1000);
    if (this.calibration) {
      const next = advanceCalibration(this.calibration, result);
      if (next.status === 'done') {
        this.baseline = { r0: next.baseline.r0, h0: next.baseline.h0, n0: next.baseline.n0 };
        this.calibration = null;
        this.frames = [];
        this.publish({ calibrating: false, progress: 1, hasBaseline: true }, true);
      } else {
        this.calibration = next;
        this.publish({ progress: next.progress, lastRestart: next.lastRestart });
      }
      return;
    }
    this.frames.push({ t, result });
    this.frames = this.frames.filter((frame) => frame.t >= t - this.bufferMs);
    this.publish({});
  }

  /** Throttled UI updates (≤4 per second) so React does not re-render on every frame. */
  private publish(patch: Partial<PipelineView>, force = false) {
    const now = this.now();
    if (!force && now - this.viewAt < 250) return;
    this.viewAt = now;
    useCameraPipeline.setState({
      ...patch,
      fps: this.analysed.length ? this.analysed.length : (patch.fps ?? null),
    });
  }
}

export const cameraPipeline = new CameraPipeline();
