import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { Level, Mode, Scenario } from '@ecolephant/ai';
import { Button, formatDuration, Modal, modeLabel, Notice } from '../components/ui';
import { measurement } from '../features/measurement/controller';
import { useMeasurement } from '../state/measurement';
import { usePreferences } from '../state/preferences';

const levelLabel: Record<Level, string> = {
  normal: '정상',
  caution: '주의',
  high: '높음',
  unknown: '판단 불가',
};
const scenarioLabel: Partial<Record<Scenario, string>> = {
  auto: '자동',
  normal: '정상',
  high: '높음',
  head_down: '고개 숙임',
  camera_lost: '카메라 끊김',
  missing: '센서 없음',
  motion: '움직임',
};

export function MeasurePage() {
  const state = useMeasurement();
  const muted = usePreferences((value) => value.muted);
  const setMuted = usePreferences((value) => value.setMuted);
  const [selectedMode, setSelectedMode] = useState<Mode>('webcam');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const running = ['starting', 'active', 'paused', 'recalibrating', 'ending'].includes(state.phase);

  useEffect(() => {
    if (!state.alert || document.hidden) return;
    const alert = state.alert;
    const frame = requestAnimationFrame(() =>
      measurement.confirmScreenAlert(alert.key, alert.stage),
    );
    return () => cancelAnimationFrame(frame);
  }, [state.alert]);

  return (
    <div>
      <div className="page-heading">
        <h1>테스트 측정</h1>
        <span className="badge neutral">가상 입력</span>
      </div>
      <Notice>AI 모델 연결 전 테스트입니다.</Notice>
      {state.error && <Notice kind="error">{state.error}</Notice>}
      {state.alert && <Notice>자세 확인 · {state.alert.stage}차 알림</Notice>}
      <section className="panel service-panel">
        <div className="service-controls">
          <label>
            측정 방식
            <select
              value={running ? state.mode : selectedMode}
              disabled={running}
              onChange={(event) => setSelectedMode(event.target.value as Mode)}
            >
              {(['webcam', 'airpods', 'combined'] as const).map((mode) => (
                <option key={mode} value={mode}>
                  {modeLabel[mode]}
                </option>
              ))}
            </select>
          </label>
          <label>
            테스트 입력
            <select
              value={state.scenario}
              onChange={(event) =>
                useMeasurement.setState({ scenario: event.target.value as Scenario })
              }
            >
              {Object.entries(scenarioLabel).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="service-metrics">
          <div>
            <span>상태</span>
            <strong>{state.latest ? levelLabel[state.latest.posture_level] : '대기'}</strong>
          </div>
          <div>
            <span>시간</span>
            <strong>{formatDuration(state.elapsedMs)}</strong>
          </div>
          <div>
            <span>저장 대기</span>
            <strong>{state.pending}개</strong>
          </div>
        </div>
        <div className="button-row service-actions">
          {!running && (
            <Button onClick={() => void measurement.start(selectedMode).catch(() => undefined)}>
              시작
            </Button>
          )}
          {['active', 'paused'].includes(state.phase) && (
            <Button variant="secondary" onClick={() => measurement.pause()}>
              {state.phase === 'paused' ? '재개' : '일시정지'}
            </Button>
          )}
          {['active', 'paused'].includes(state.phase) && (
            <Button
              variant="secondary"
              disabled={state.pending > 550}
              onClick={() => measurement.recalibrate()}
            >
              기준 재설정
            </Button>
          )}
          {!state.missingSession &&
            ['active', 'paused', 'recalibrating', 'ending'].includes(state.phase) && (
              <Button
                disabled={state.saving}
                onClick={() => void measurement.finish().catch(() => undefined)}
              >
                {state.saving ? '저장 중' : state.phase === 'ending' ? '저장 재시도' : '종료·저장'}
              </Button>
            )}
          {state.missingSession && (
            <Button
              variant="danger"
              disabled={state.saving}
              onClick={() => setConfirmDiscard(true)}
            >
              측정 정리
            </Button>
          )}
          <Button variant="ghost" onClick={() => setMuted(!muted)}>
            {muted ? '알림 켜기' : '알림 끄기'}
          </Button>
        </div>
        {state.phase === 'starting' && (
          <p className="service-note" role="status">
            시작 중
          </p>
        )}
        {state.memoryFull && <Notice kind="error">저장 연결을 확인해 주세요.</Notice>}
      </section>
      <Modal
        open={state.missingSession && confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="측정 정리"
        description="저장하지 못한 결과가 지워집니다."
      >
        <div className="button-row modal-actions">
          <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
            취소
          </Button>
          <Button
            variant="danger"
            disabled={state.saving}
            onClick={() => {
              if (measurement.discardMissing()) setConfirmDiscard(false);
            }}
          >
            정리
          </Button>
        </div>
      </Modal>
      {state.phase === 'completed' && state.session && (
        <Link
          to="/history/$sessionId"
          params={{ sessionId: state.session.id }}
          className="button button-secondary"
        >
          저장된 기록
        </Link>
      )}
    </div>
  );
}
