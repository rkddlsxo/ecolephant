import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CameraModelResult } from '../model-adapter';
import { POSE_MODELS, createMediaPipeAdapter, type PoseModelVariant } from './mediapipe-adapter';
import type { RawLandmark } from './pose-result';

/**
 * Development-only check that real landmarks come out of the webcam.
 * Draws points locally on a canvas; results are never stored or sent anywhere.
 */
export function poseDebugEnabled(search = window.location.search) {
  return import.meta.env.DEV && new URLSearchParams(search).has('pose-debug');
}

/** `?pose-debug&model=full` picks the model, `&all` also draws all 33 raw points. */
export function poseDebugSettings(search = window.location.search) {
  const params = new URLSearchParams(search);
  const model = params.get('model');
  const variant: PoseModelVariant = POSE_MODELS.includes(model as PoseModelVariant)
    ? (model as PoseModelVariant)
    : 'lite';
  return { variant, showAll: params.has('all') };
}

const colors: Record<CameraModelResult['quality'], string> = {
  valid: '#3ddc84',
  motion: '#ffb020',
  low_confidence: '#ff5d5d',
  no_pose: '#9aa5a0',
};

interface Stats {
  status: 'loading' | 'running' | 'error';
  message?: string;
  quality?: CameraModelResult['quality'];
  fps?: number;
  inferenceMs?: number;
  delegate?: string | null;
  variant?: PoseModelVariant;
}

/** Target analysis rate for the overlay only; the measurement loop decides its own rate. */
const INTERVAL_MS = 1000 / 15;

export function PoseDebugOverlay({
  videoRef,
  mirrored,
  active,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  mirrored: boolean;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState<Stats>({ status: 'loading' });

  useEffect(() => {
    if (!active) return;
    const canvasElement = canvasRef.current;
    const { variant, showAll } = poseDebugSettings();
    let raw: readonly RawLandmark[] | undefined;
    const adapter = createMediaPipeAdapter({
      variant,
      onRawPose: showAll ? (pose) => (raw = pose) : undefined,
    });
    let frame = 0;
    let stopped = false;
    let last = 0;
    const times: number[] = [];
    let inference = 0;

    const draw = (result: CameraModelResult) => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      const { clientWidth: w, clientHeight: h } = canvas;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const context = canvas.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, w, h);
      // Match the video's object-fit: contain box.
      const scale = Math.min(w / result.frameWidth, h / result.frameHeight);
      const dw = result.frameWidth * scale;
      const dh = result.frameHeight * scale;
      const ox = (w - dw) / 2;
      const oy = (h - dh) / 2;
      if (showAll && raw) {
        context.fillStyle = '#ffffff';
        for (const point of raw) {
          context.globalAlpha = 0.25 + 0.6 * Math.max(0, Math.min(1, point.visibility ?? 0));
          context.beginPath();
          context.arc(ox + point.x * dw, oy + point.y * dh, 3, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.fillStyle = colors[result.quality];
      for (const point of Object.values(result.landmarks)) {
        if (!point) continue;
        context.globalAlpha = 0.35 + 0.65 * point.confidence;
        context.beginPath();
        context.arc(ox + point.x * dw, oy + point.y * dh, 6, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const tick = async (now: number) => {
      if (stopped) return;
      const video = videoRef.current;
      if (video && now - last >= INTERVAL_MS && video.readyState >= 2 && video.videoWidth > 0) {
        last = now;
        try {
          const started = performance.now();
          const result = await adapter.analyze(video, now);
          inference = 0.8 * inference + 0.2 * (performance.now() - started);
          times.push(now);
          while (times.length && now - times[0] > 1000) times.shift();
          if (!stopped) {
            draw(result);
            setStats({
              status: 'running',
              quality: result.quality,
              fps: times.length,
              inferenceMs: Math.round(inference * 10) / 10,
              delegate: adapter.delegate,
              variant,
            });
          }
        } catch (error) {
          if (!stopped && !(error instanceof Error && error.name === 'VideoNotReadyError'))
            setStats({ status: 'error', message: String(error) });
        }
      }
      if (!stopped) frame = requestAnimationFrame((t) => void tick(t));
    };

    adapter
      .load()
      .then(() => {
        if (!stopped) frame = requestAnimationFrame((t) => void tick(t));
      })
      .catch((error) => {
        if (!stopped)
          setStats({
            status: 'error',
            message: `${variant} 모델을 불러오지 못했어요. npm run pose:assets -- --model ${variant} 실행 여부를 확인해 주세요. (${String(error)})`,
          });
      });

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      adapter.close();
      canvasElement?.getContext('2d')?.clearRect(0, 0, canvasElement.width, canvasElement.height);
    };
  }, [active, videoRef]);

  if (!active) return null;
  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          // Display-only mirror, same as the video; landmark coordinates stay unmirrored.
          transform: mirrored ? 'scaleX(-1)' : undefined,
        }}
      />
      <p
        data-testid="pose-debug-stats"
        style={{
          position: 'absolute',
          left: 8,
          top: 8,
          margin: 0,
          padding: '4px 8px',
          borderRadius: 6,
          background: 'rgba(0,0,0,0.6)',
          color: '#fff',
          font: '12px/1.4 ui-monospace, monospace',
        }}
      >
        {stats.status === 'loading' && '포즈 모델 불러오는 중…'}
        {stats.status === 'error' && stats.message}
        {stats.status === 'running' &&
          `${stats.variant} · ${stats.quality} · ${stats.fps} fps · ${stats.inferenceMs} ms · ${stats.delegate}`}
      </p>
    </>
  );
}
