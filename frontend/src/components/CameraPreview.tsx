import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff } from 'lucide-react';
import { Button } from './ui';

export function CameraPreview() {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState(
    '권한 확인용 미리보기입니다. 자세 분석에는 사용되지 않아요.',
  );
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  function stop() {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setEnabled(false);
  }
  useEffect(() => {
    mounted.current = true;
    const hidden = () => {
      if (document.hidden) stop();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', hidden);
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  async function start() {
    setBusy(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('카메라를 지원하는 브라우저와 보안 연결이 필요해요.');
      const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (!mounted.current || document.hidden) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      setEnabled(true);
      if (video.current) {
        video.current.srcObject = media;
        await video.current.play();
      }
      setMessage('미리보기만 켜졌어요. 영상은 서버에 전송되지 않습니다.');
    } catch (error) {
      stop();
      if (mounted.current)
        setMessage(
          error instanceof DOMException
            ? '권한이 거부되었거나 카메라를 사용할 수 없어요. 데모는 계속 이용할 수 있어요.'
            : String(error),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="camera-preview">
      <video
        ref={video}
        muted
        playsInline
        className={enabled ? '' : 'hidden'}
        aria-label="로컬 카메라 미리보기"
      />
      <div>
        <strong>
          <Camera size={17} /> 카메라 권한 확인 <span className="badge neutral">선택</span>
        </strong>
        <p aria-live="polite">{message}</p>
      </div>
      <Button variant="secondary" disabled={busy} onClick={enabled ? stop : start}>
        {enabled ? (
          <>
            <CameraOff size={15} /> 끄기
          </>
        ) : (
          <>
            <Camera size={15} /> 미리보기 켜기
          </>
        )}
      </Button>
    </div>
  );
}
