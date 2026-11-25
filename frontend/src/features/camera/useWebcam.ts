import { useCallback, useEffect, useRef, useState } from 'react';
import { backgroundMode } from '../measurement/background-probe';
import { holdCamera, shouldKeepCamera, takeHeldCamera } from './background-camera';

export type CameraStatus = 'idle' | 'requesting' | 'playing' | 'stopped' | 'error';
const initialMessage = '카메라 켜기를 누르면 브라우저에서 권한을 요청합니다.';

const playingMessage = '카메라가 켜졌어요. 영상은 현재 화면에만 표시됩니다.';
const playingInBackgroundMessage =
  '카메라가 켜졌어요. 다른 창이나 다른 메뉴로 옮겨도 측정 중에는 이 브라우저 안에서 자세 분석이 계속돼요. 영상은 밖으로 보내지 않아요.';

function keepsInBackground(keepWhenHidden: boolean) {
  return keepWhenHidden || backgroundMode() === 'timer';
}

function trackEnded(track: MediaStreamTrack): boolean {
  return track.readyState === 'ended';
}

function cameraError(error: unknown) {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return '카메라 권한이 필요해요. 주소창의 권한 설정에서 카메라를 허용한 뒤 다시 눌러 주세요.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return '사용 가능한 카메라를 찾지 못했어요. 카메라 연결을 확인해 주세요.';
  if (name === 'NotReadableError' || name === 'AbortError')
    return '카메라를 열 수 없어요. 다른 앱의 카메라 사용을 종료하거나 장치 연결을 확인해 주세요.';
  return '카메라를 시작하지 못했어요. 브라우저와 장치 상태를 확인한 뒤 다시 눌러 주세요.';
}

/**
 * Preview only: no frame reads, model inference, recording, or API uploads.
 * `keepWhenHidden` (analysis pages): keep the camera on when the tab is hidden, and during a
 * camera measurement hand the stream to `background-camera` when the page unmounts so analysis
 * keeps running on other pages of the app (DEC-010). Frames still never leave the browser.
 */
export function useWebcam({ keepWhenHidden = false }: { keepWhenHidden?: boolean } = {}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const requesting = useRef(false);
  const removeTrackListener = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [message, setMessage] = useState(initialMessage);
  const [resolution, setResolution] = useState('');

  const release = useCallback(() => {
    generation.current += 1;
    requesting.current = false;
    removeTrackListener.current?.();
    removeTrackListener.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  }, []);

  const stop = useCallback(
    (reason = '카메라를 껐어요. 다시 켜려면 버튼을 눌러 주세요.') => {
      release();
      if (mounted.current) {
        setStatus('stopped');
        setMessage(reason);
        setResolution('');
      }
    },
    [release],
  );

  /** Show a recoverable error when this request's track ends (device unplugged, permission). */
  const watchTrack = useCallback(
    (track: MediaStreamTrack, request: number) => {
      const ended = () => {
        if (!mounted.current || request !== generation.current) return;
        release();
        setStatus('error');
        setMessage('카메라 연결이 종료되었어요. 연결과 권한을 확인해 주세요.');
        setResolution('');
      };
      track.addEventListener('ended', ended);
      removeTrackListener.current = () => track.removeEventListener('ended', ended);
      return ended;
    },
    [release],
  );

  const playing = useCallback(
    (track: MediaStreamTrack) => {
      const settings = track.getSettings();
      setResolution(
        settings.width && settings.height ? `${settings.width} × ${settings.height}` : '',
      );
      setStatus('playing');
      setMessage(keepWhenHidden ? playingInBackgroundMessage : playingMessage);
    },
    [keepWhenHidden],
  );

  useEffect(() => {
    mounted.current = true;
    // Take back a stream that kept a camera measurement running while off this page. This is
    // synchronous so a StrictMode remount hands it over again instead of stopping it.
    const kept = keepWhenHidden ? takeHeldCamera() : null;
    const keptTrack = kept?.getVideoTracks()[0];
    if (kept && keptTrack && videoRef.current) {
      streamRef.current = kept;
      watchTrack(keptTrack, generation.current);
      videoRef.current.srcObject = kept;
      void videoRef.current.play().catch(() => undefined);
      playing(keptTrack);
    } else kept?.getTracks().forEach((track) => track.stop());
    const hidden = () => {
      // Analysis pages (and dev `?bg=timer`) keep the camera on in the background (DEC-010).
      if (keepsInBackground(keepWhenHidden)) return;
      if (document.hidden && (streamRef.current || requesting.current))
        stop('화면이 비활성화되어 카메라를 껐어요. 다시 켜려면 버튼을 눌러 주세요.');
    };
    const leaving = () => stop('페이지를 떠나 카메라를 껐어요. 다시 켜려면 버튼을 눌러 주세요.');
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
      // Moving to another page during a camera measurement: keep the camera and analysis on.
      const stream = streamRef.current;
      if (keepWhenHidden && stream && !requesting.current && shouldKeepCamera()) {
        streamRef.current = null;
        release();
        holdCamera(stream);
        return;
      }
      release();
    };
  }, [release, stop, keepWhenHidden, watchTrack, playing]);

  const start = useCallback(async () => {
    if (!mounted.current || document.hidden || requesting.current || streamRef.current) return;
    release();
    const request = generation.current;
    requesting.current = true;
    setStatus('requesting');
    setMessage('브라우저의 카메라 권한 요청을 확인해 주세요.');
    let acquired: MediaStream | null = null;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        if (mounted.current) {
          setStatus('error');
          setMessage('카메라는 localhost 또는 HTTPS에서 지원되는 브라우저로 열어 주세요.');
        }
        return;
      }
      acquired = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (!mounted.current || request !== generation.current) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      if (document.hidden && !keepsInBackground(keepWhenHidden)) {
        acquired.getTracks().forEach((track) => track.stop());
        stop('화면이 비활성화되어 카메라를 껐어요. 다시 켜려면 버튼을 눌러 주세요.');
        return;
      }
      const video = videoRef.current;
      if (!video) {
        acquired.getTracks().forEach((track) => track.stop());
        setStatus('error');
        setMessage('카메라 화면을 준비하지 못했어요. 페이지를 새로 열어 주세요.');
        return;
      }
      streamRef.current = acquired;
      const track = acquired.getVideoTracks()[0];
      if (!track) throw new DOMException('No video track', 'NotFoundError');
      const ended = watchTrack(track, request);
      if (trackEnded(track)) {
        ended();
        return;
      }
      video.srcObject = acquired;
      await video.play();
      if (!mounted.current || request !== generation.current) {
        acquired.getTracks().forEach((item) => item.stop());
        return;
      }
      if (document.hidden && !keepsInBackground(keepWhenHidden)) {
        stop('화면이 비활성화되어 카메라를 껐어요. 다시 켜려면 버튼을 눌러 주세요.');
        return;
      }
      if (trackEnded(track)) {
        ended();
        return;
      }
      playing(track);
    } catch (error) {
      acquired?.getTracks().forEach((track) => track.stop());
      if (mounted.current && request === generation.current) {
        release();
        setStatus('error');
        setMessage(cameraError(error));
        setResolution('');
      }
    } finally {
      if (request === generation.current) requesting.current = false;
    }
  }, [release, stop, keepWhenHidden, watchTrack, playing]);

  const cancel = useCallback(
    () => stop('카메라 요청을 취소했어요. 권한 창이 열려 있다면 직접 닫아 주세요.'),
    [stop],
  );
  return { videoRef, status, message, resolution, start, stop, cancel };
}
