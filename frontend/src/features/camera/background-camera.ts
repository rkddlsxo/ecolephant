import { create } from 'zustand';
import { cameraPipeline } from '../measurement/camera-pipeline';
import { useMeasurement, type Phase } from '../../state/measurement';

/**
 * Keeps the webcam running while a camera measurement goes on and the user moves to another
 * page of the app (DEC-010). The preview hands its stream over when it unmounts; a hidden video
 * element outside the page tree keeps feeding the pose pipeline, and the next analysis preview
 * takes the stream back. Frames still never leave the browser.
 */
const RUNNING: Phase[] = ['starting', 'active', 'paused', 'recalibrating', 'ending'];

export function cameraMeasurementRunning() {
  const { phase, input } = useMeasurement.getState();
  return input === 'camera' && RUNNING.includes(phase);
}

/**
 * Keep the camera when an analysis preview leaves the page: during a camera measurement, or once
 * a baseline is taken on the calibration page so the measurement page (which has no preview of
 * its own) can start with it.
 */
export function shouldKeepCamera() {
  return cameraMeasurementRunning() || cameraPipeline.hasBaseline;
}

/** `on`: a held stream is analysed off-page, so the shell shows the camera indicator. */
export const useBackgroundCamera = create<{ on: boolean }>(() => ({ on: false }));

let held: { stream: MediaStream; video: HTMLVideoElement; cleanup: () => void } | null = null;

function drop() {
  if (!held) return null;
  const current = held;
  held = null;
  current.cleanup();
  cameraPipeline.detach(current.video);
  current.video.pause();
  current.video.srcObject = null;
  current.video.remove();
  useBackgroundCamera.setState({ on: false });
  return current.stream;
}

/** Take over a playing stream when the analysis preview leaves the page. */
export function holdCamera(stream: MediaStream) {
  stopBackgroundCamera();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute('aria-hidden', 'true');
  video.dataset.backgroundCamera = '';
  // Rendered (not display:none) so frames keep decoding, but invisible.
  Object.assign(video.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
  });
  document.body.appendChild(video);
  video.srcObject = stream;
  void video.play().catch(() => undefined);
  const track = stream.getVideoTracks()[0];
  const ended = () => stopBackgroundCamera();
  track?.addEventListener('ended', ended);
  held = { stream, video, cleanup: () => track?.removeEventListener('ended', ended) };
  cameraPipeline.attach(video);
  useBackgroundCamera.setState({ on: true });
}

/** Give the held stream back to an analysis preview (without stopping it). */
export function takeHeldCamera(): MediaStream | null {
  const stream = drop();
  if (stream && stream.getVideoTracks().some((track) => track.readyState === 'ended')) {
    stream.getTracks().forEach((track) => track.stop());
    return null;
  }
  return stream;
}

/** Turn the off-page camera off. The measurement keeps going; its windows become no_sensor. */
export function stopBackgroundCamera() {
  drop()
    ?.getTracks()
    .forEach((track) => track.stop());
}

// A camera measurement ended (saved, discarded, failed) while the camera was off-page: release it.
let wasRunning = cameraMeasurementRunning();
useMeasurement.subscribe(() => {
  const running = cameraMeasurementRunning();
  if (wasRunning && !running && held) stopBackgroundCamera();
  wasRunning = running;
});
if (typeof window !== 'undefined') window.addEventListener('pagehide', stopBackgroundCamera);
