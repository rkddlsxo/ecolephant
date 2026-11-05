import { useState } from 'react';
import { useWebcam } from '../features/camera/useWebcam';
import { PoseDebugOverlay, poseDebugEnabled } from '../features/measurement/pose/PoseDebugOverlay';
import { Button } from './ui';

export function CameraPreview() {
  const camera = useWebcam();
  const [mirrored, setMirrored] = useState(true);
  const [poseDebug] = useState(() => poseDebugEnabled());
  const playing = camera.status === 'playing';
  const requesting = camera.status === 'requesting';
  return (
    <section className="panel webcam-panel" aria-labelledby="webcam-title">
      <div className="section-heading">
        <h2 id="webcam-title">카메라</h2>
        <span className="badge neutral">{playing ? '켜짐' : requesting ? '연결 중' : '꺼짐'}</span>
      </div>
      <div className={`webcam-stage ${playing ? 'is-playing' : ''}`}>
        <video
          ref={camera.videoRef}
          muted
          playsInline
          autoPlay
          className={mirrored ? 'mirrored' : ''}
          aria-label="실시간 웹캠 미리보기"
        />
        {poseDebug && (
          <PoseDebugOverlay videoRef={camera.videoRef} mirrored={mirrored} active={playing} />
        )}
        {!playing && (
          <div className="webcam-empty">{requesting ? '권한 요청 중' : '카메라 꺼짐'}</div>
        )}
      </div>
      {camera.status === 'error' && (
        <p className="field-error" role="alert">
          {camera.message}
        </p>
      )}
      <div className="button-row service-actions">
        {playing ? (
          <>
            <Button variant="secondary" onClick={() => camera.stop()}>
              끄기
            </Button>
            <Button
              variant="secondary"
              onClick={() => setMirrored((value) => !value)}
              aria-pressed={mirrored}
            >
              좌우 반전
            </Button>
          </>
        ) : requesting ? (
          <Button variant="secondary" onClick={camera.cancel}>
            요청 취소
          </Button>
        ) : (
          <Button onClick={() => void camera.start()}>
            {camera.status === 'error' ? '다시 켜기' : '켜기'}
          </Button>
        )}
      </div>
    </section>
  );
}
