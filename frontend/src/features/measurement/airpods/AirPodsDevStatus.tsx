import { Headphones } from 'lucide-react';
import { Button } from '../../../components/ui';
import {
  airpodsLink,
  airpodsSign,
  airpodsStatusLabel,
  helperUrl,
  pitchRestartLabel,
  useAirPods,
} from './airpods-link';

/**
 * One status line for the AirPods helper on the dev flag `?airpods=helper` (DEC-003 testing).
 * Shown inside the existing calibration control; no page layout change. The pairing code is
 * typed into a browser prompt and kept in memory only.
 */
export function AirPodsDevStatus() {
  const view = useAirPods();
  const live = !['off', 'error'].includes(view.status);
  const connect = () => {
    const code = window.prompt('AirPods 도우미 터미널에 나온 페어링 코드를 붙여 넣어 주세요.');
    if (code) airpodsLink.connect(helperUrl(), code, airpodsSign());
  };
  return (
    <div className="calibration-pending" role="status" data-testid="airpods-dev-status">
      <Headphones size={14} aria-hidden="true" />
      <span>
        AirPods(개발용): {airpodsStatusLabel[view.status]}
        {view.sampleRateHz !== null && ` · ${view.sampleRateHz}Hz`}
        {view.rttMs !== null && ` · 왕복 ${view.rttMs}ms`}
        {view.calibrating && ` · 기준 측정 ${Math.round(view.progress * 100)}%`}
        {view.hasBaseline && view.flexionDeg !== null && ` · 고개 숙임 ${view.flexionDeg}°`}
        {view.hasBaseline && view.flexionDeg === null && ' · 기준 저장됨'}
        {view.gaps > 0 && ` · 빠진 값 ${view.gaps}개`}
        {` · 축 부호 ${view.sign > 0 ? '+1' : '−1'}(검증 전)`}
        {view.lastRestart && (
          <span className="field-error"> {pitchRestartLabel[view.lastRestart]}</span>
        )}
        {view.error && <span className="field-error"> {view.error}</span>}
      </span>
      {live ? (
        <>
          {view.status === 'streaming' && !view.calibrating && (
            <Button variant="secondary" onClick={() => airpodsLink.beginCalibration()}>
              AirPods 기준만 다시 잡기
            </Button>
          )}
          <Button variant="secondary" onClick={() => airpodsLink.disconnect()}>
            연결 끊기
          </Button>
        </>
      ) : (
        <Button variant="secondary" onClick={connect}>
          AirPods 도우미 연결
        </Button>
      )}
    </div>
  );
}
