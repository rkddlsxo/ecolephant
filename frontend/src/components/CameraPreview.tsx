import { useEffect, useState } from 'react';
import { useWebcam } from '../features/camera/useWebcam';
import { cameraPipeline, useCameraPipeline } from '../features/measurement/camera-pipeline';
import { GuideSilhouette } from '../features/measurement/GuideSilhouette';
import { PoseDebugOverlay, poseDebugEnabled } from '../features/measurement/pose/PoseDebugOverlay';
import { Button } from './ui';

/**
 * `analyze`: connect the playing video to the measurement pose pipeline (calibration and
 * measurement pages). The dev point overlay is hidden then, so the model runs only once, and
 * the `defaultGuide` silhouette is drawn instead.
 * `hideable`: offer a button that hides the picture while analysis keeps running. The video
 * stays rendered (transparent, 1 px) instead of `display: none` so frames keep decoding.
 */
export function CameraPreview({
  analyze = false,
  hideable = false,
}: {
  analyze?: boolean;
  hideable?: boolean;
}) {
  // Analysis pages keep the camera on in the background so measurement continues (DEC-010).
  const camera = useWebcam({ keepWhenHidden: analyze });
  const [mirrored, setMirrored] = useState(true);
  const [concealed, setConcealed] = useState(false);
  const [poseDebug] = useState(() => poseDebugEnabled());
  const playing = camera.status === 'playing';
  const requesting = camera.status === 'requesting';
  const pipeline = useCameraPipeline();
  const { videoRef } = camera;
  const hidden = hideable && concealed && playing;

  useEffect(() => {
    if (!analyze || !playing) return;
    const video = videoRef.current;
    cameraPipeline.attach(video);
    // Only detach our own video: when leaving during a measurement the background camera has
    // already taken over the pipeline.
    return () => cameraPipeline.detach(video);
  }, [analyze, playing, videoRef]);

  return (
    <section className="panel webcam-panel" aria-labelledby="webcam-title">
      <div className="section-heading">
        <div className="title-with-status">
          <h2 id="webcam-title">카메라</h2>
          <span
            className={`status-dot ${playing ? 'on' : 'off'}`}
            role="img"
            aria-label={playing ? '카메라 켜짐' : requesting ? '카메라 연결 중' : '카메라 꺼짐'}
            title={playing ? '켜짐' : requesting ? '연결 중' : '꺼짐'}
          />
          <span className="camera-note">
            {analyze && pipeline.status === 'running'
              ? `자세 분석 중${pipeline.fps ? ` · ${pipeline.fps}fps` : ''}${pipeline.delegate ? ` · ${pipeline.delegate}` : ''} · 영상은 서버로 전송하지 않음`
              : analyze && pipeline.status === 'loading'
                ? 'AI 모델 불러오는 중 · 영상은 서버로 전송하지 않음'
                : '영상은 이 기기에서만 분석하고 서버로 전송하지 않음'}
          </span>
        </div>
        {playing ? (
          <div className="button-row">
            {hideable && (
              <Button
                variant="secondary"
                onClick={() => setConcealed((value) => !value)}
                aria-pressed={concealed}
              >
                {concealed ? '미리보기 보기' : '미리보기 숨기기'}
              </Button>
            )}
            {!hidden && (
              <Button
                variant="secondary"
                onClick={() => setMirrored((value) => !value)}
                aria-pressed={mirrored}
              >
                좌우 반전
              </Button>
            )}
            <Button variant="secondary" onClick={() => camera.stop()}>
              끄기
            </Button>
          </div>
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
      <div
        className={`webcam-stage ${playing ? 'is-playing' : ''} ${hidden ? 'is-concealed' : ''}`}
      >
        <video
          ref={camera.videoRef}
          muted
          playsInline
          autoPlay
          className={mirrored ? 'mirrored' : ''}
          aria-label="실시간 웹캠 미리보기"
        />
        {poseDebug && !analyze && (
          <PoseDebugOverlay videoRef={camera.videoRef} mirrored={mirrored} active={playing} />
        )}
        {analyze && playing && !hidden && (
          <GuideSilhouette
            videoRef={camera.videoRef}
            mirrored={mirrored}
            fit={pipeline.guide === 'ok'}
          />
        )}
        {hidden && (
          <div className="webcam-concealed" role="status">
            미리보기를 숨겼어요 · 자세 분석은 계속돼요
          </div>
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
      {analyze && pipeline.status === 'error' && pipeline.error && (
        <p className="field-error" role="alert">
          {pipeline.error}
        </p>
      )}
    </section>
  );
}
