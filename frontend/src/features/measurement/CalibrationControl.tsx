import { CheckCircle2, Info } from 'lucide-react';
import { calibrationTips, guideLabel } from '@ecolephant/ai';
import { Button } from '../../components/ui';
import {
  cameraPipeline,
  restartLabel,
  useCameraPipeline,
  type PipelineView,
} from './camera-pipeline';

/** Guide check result as one line of text (no layout change; the silhouette is drawn by the page). */
function guideText(guide: PipelineView['guide']) {
  if (guide === null) return null;
  return guide === 'ok' ? '가이드 안에 잘 앉았어요.' : guideLabel[guide];
}

/**
 * Start / progress / result of the 3 s baseline calibration on the real camera.
 * Shared by the calibration page and the measurement page.
 */
export function CalibrationControl({ disabled = false }: { disabled?: boolean }) {
  const view = useCameraPipeline();
  const ready = view.status === 'running';
  if (view.calibrating)
    return (
      <div className="calibration-progress" role="status">
        <progress max={1} value={view.progress} aria-label="기준 자세 측정 진행" />
        <p>
          편한 자세로 가만히 있어 주세요 · {Math.round(view.progress * 100)}%
          {view.lastRestart && (
            <span className="field-error"> {restartLabel[view.lastRestart]}</span>
          )}
          {view.guide && view.guide !== 'ok' && (
            <span className="field-error"> {guideText(view.guide)}</span>
          )}
        </p>
        <Button variant="secondary" onClick={() => cameraPipeline.cancelCalibration()}>
          취소
        </Button>
      </div>
    );
  return (
    <div className="calibration-progress">
      <Button
        className="calibration-start"
        disabled={disabled || !ready}
        onClick={() => cameraPipeline.beginCalibration()}
      >
        {view.hasBaseline ? '기준 자세 다시 잡기' : '보정 시작'}
      </Button>
      {view.hasBaseline ? (
        <p className="calibration-pending">
          <CheckCircle2 size={14} aria-hidden="true" />
          기준 자세를 저장했어요. 이 기기 안에만 보관하고 서버로 보내지 않아요.
        </p>
      ) : !ready ? (
        <p className="calibration-pending">
          <Info size={14} aria-hidden="true" />
          {view.status === 'loading'
            ? 'AI 모델을 불러오는 중이에요.'
            : '카메라를 켜면 보정을 시작할 수 있어요.'}
        </p>
      ) : (
        <div className="calibration-guide">
          <p className="calibration-pending">
            <Info size={14} aria-hidden="true" />
            바른 자세를 기준으로 저장해요. 시작 전에 확인해 주세요.
          </p>
          <ul className="calibration-tips">
            {calibrationTips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
          {guideText(view.guide) && (
            <p className="calibration-pending" role="status">
              {guideText(view.guide)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
