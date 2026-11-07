import { CameraPreview } from '../components/CameraPreview';

export function PreparePage() {
  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>카메라 확인</h1>
          <p className="page-description">
            측정을 시작하기 전에 웹캠에 상체가 화면 안에 잘 들어오는지, 밝기와 각도가 괜찮은지
            확인하는 화면이에요.
          </p>
        </div>
      </div>
      <CameraPreview />
    </div>
  );
}
