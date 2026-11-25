import { useEffect, useState, type RefObject } from 'react';
import { defaultGuide, type GuideShape } from '@ecolephant/ai';

/** Frame size used before the video reports its own (the webcam asks for 1280 × 720). */
const FALLBACK = { width: 1280, height: 720 };

const mid = (range: { min: number; max: number }) => (range.min + range.max) / 2;

/**
 * Head-and-shoulders outline in original-frame pixels, built from the middle of each
 * `defaultGuide` range so it matches what `guideFit` accepts.
 */
export function silhouettePaths(width: number, height: number, guide: GuideShape = defaultGuide) {
  const cx = guide.centerX * width;
  const sw = mid(guide.shoulderWidth) * width;
  const shoulderY = mid(guide.shoulderY) * height;
  const earY = mid(guide.earY) * height;
  // Ears sit near the middle of the head; the head is a bit taller than wide.
  const rx = sw * 0.26;
  const ry = rx * 1.3;
  const headY = earY - ry * 0.1;
  const neck = rx * 0.55;
  const neckTop = headY + ry * 0.85;
  const drop = sw * 0.12;
  const half = sw / 2;
  const x = (dx: number) => (cx + dx).toFixed(1);
  const y = (value: number) => value.toFixed(1);
  const body = [
    `M ${x(-neck)} ${y(neckTop)}`,
    `L ${x(-neck)} ${y(shoulderY - drop)}`,
    `C ${x(-neck - sw * 0.1)} ${y(shoulderY - drop * 0.5)} ${x(-half)} ${y(shoulderY - drop * 0.6)} ${x(-half - sw * 0.02)} ${y(shoulderY + drop * 0.4)}`,
    `L ${x(-half - sw * 0.06)} ${y(height + 4)}`,
    `L ${x(half + sw * 0.06)} ${y(height + 4)}`,
    `L ${x(half + sw * 0.02)} ${y(shoulderY + drop * 0.4)}`,
    `C ${x(half)} ${y(shoulderY - drop * 0.6)} ${x(neck + sw * 0.1)} ${y(shoulderY - drop * 0.5)} ${x(neck)} ${y(shoulderY - drop)}`,
    `L ${x(neck)} ${y(neckTop)}`,
  ].join(' ');
  return { head: { cx, cy: headY, rx, ry }, body };
}

function useVideoSize(videoRef: RefObject<HTMLVideoElement | null>) {
  const [size, setSize] = useState(FALLBACK);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const update = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0)
        setSize({ width: video.videoWidth, height: video.videoHeight });
    };
    update();
    video.addEventListener('loadedmetadata', update);
    video.addEventListener('resize', update);
    return () => {
      video.removeEventListener('loadedmetadata', update);
      video.removeEventListener('resize', update);
    };
  }, [videoRef]);
  return size;
}

/**
 * Drawn over the preview only; nothing is read from the frames here. `slice` matches the
 * video's `object-fit: cover`, so the outline sits where the frame fractions point.
 */
export function GuideSilhouette({
  videoRef,
  mirrored,
  fit,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  mirrored: boolean;
  fit: boolean;
}) {
  const { width, height } = useVideoSize(videoRef);
  const { head, body } = silhouettePaths(width, height);
  return (
    <svg
      className={`guide-silhouette ${fit ? 'is-fit' : ''} ${mirrored ? 'mirrored' : ''}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      data-testid="guide-silhouette"
    >
      <ellipse cx={head.cx} cy={head.cy} rx={head.rx} ry={head.ry} />
      <path d={body} />
    </svg>
  );
}
