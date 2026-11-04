import { Link } from '@tanstack/react-router';
import { CameraPreview } from '../components/CameraPreview';

export function PreparePage() {
  return (
    <div>
      <div className="page-heading">
        <h1>카메라</h1>
      </div>
      <CameraPreview />
      <div className="button-row service-actions">
        <Link to="/measure" className="button button-primary">
          테스트 측정
        </Link>
        <Link to="/history" className="button button-secondary">
          기록
        </Link>
      </div>
      <p className="service-note">AI 모델 연결 대기 · 영상은 서버로 전송하지 않음</p>
    </div>
  );
}
