import { Info, Lightbulb, Move, ScanFace, Sofa, Sun } from 'lucide-react';
import { CameraPreview } from '../components/CameraPreview';
import { Button } from '../components/ui';

const steps = [
  {
    title: '센서 확인',
    description: '카메라가 켜져 있고 얼굴과 어깨가 화면 안에 들어오는지 확인해요.',
  },
  {
    title: '편한 자세 유지',
    description: '평소 작업할 때의 편한 자세로 약 3초 동안 가만히 있어요.',
  },
  {
    title: '기준 저장',
    description: '안정된 구간을 기준으로 저장해요. 움직임이 있으면 다시 측정해요.',
  },
] as const;

const tips = [
  { Icon: ScanFace, text: '화면을 정면으로 바라봐 주세요.' },
  { Icon: Sun, text: '얼굴이 어둡지 않도록 밝은 곳에서 해 주세요.' },
  { Icon: Sofa, text: '평소 작업할 때처럼 편하게 앉아 주세요.' },
  { Icon: Move, text: '웹캠·화면 위치를 바꿨다면 다시 보정해 주세요.' },
] as const;

export function CalibrationPage() {
  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>기준 자세 보정</h1>
          <p className="page-description">
            측정 전에 지금의 편한 자세를 기준으로 잡아요. 측정 중에는 이 기준에서 얼마나
            벗어났는지를 확인해요.
          </p>
        </div>
      </div>

      <div className="calibration-layout">
        <CameraPreview />

        <div className="calibration-side">
          <section className="panel calibration-card" aria-labelledby="calibration-steps-title">
            <h2 id="calibration-steps-title">보정 순서</h2>
            <ol className="calibration-steps">
              {steps.map((step, index) => (
                <li key={step.title}>
                  <span className="calibration-step-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div>
                    <strong>{step.title}</strong>
                    <p>{step.description}</p>
                  </div>
                </li>
              ))}
            </ol>
            <Button className="calibration-start" disabled>
              보정 시작
            </Button>
            <p className="calibration-pending">
              <Info size={14} aria-hidden="true" />
              AI 모델이 연결되면 사용할 수 있어요.
            </p>
          </section>

          <section className="panel calibration-card" aria-labelledby="calibration-tips-title">
            <h2 id="calibration-tips-title">
              <Lightbulb size={18} aria-hidden="true" />
              보정 전에 확인해 주세요
            </h2>
            <ul className="calibration-tips">
              {tips.map(({ Icon, text }) => (
                <li key={text}>
                  <Icon size={16} aria-hidden="true" />
                  {text}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      <p className="calibration-disclaimer">
        기준 자세는 사용자의 평소 편한 자세일 뿐, 바른 자세의 의학적 기준이 아니에요.
      </p>
    </div>
  );
}
