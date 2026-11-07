import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { Level, Mode, Scenario } from '@ecolephant/ai';
import { Bell, BellOff, Gauge, HardDriveUpload, History, Timer } from 'lucide-react';
import { Button, ErrorState, formatDuration, Modal, modeLabel, Notice } from '../components/ui';
import { Select } from '../components/Select';
import { measurement } from '../features/measurement/controller';
import { usePolicyCheck } from '../features/measurement/policy';
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

const modeOptions = (['webcam', 'airpods', 'combined'] as const).map((mode) => ({
  value: mode,
  label: modeLabel[mode],
}));
const scenarioOptions = (Object.entries(scenarioLabel) as [Scenario, string][]).map(
  ([value, label]) => ({ value, label }),
);

export function MeasurePage() {
  const state = useMeasurement();
  const muted = usePreferences((value) => value.muted);
  const setMuted = usePreferences((value) => value.setMuted);
  const [selectedMode, setSelectedMode] = useState<Mode>('webcam');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const running = ['starting', 'active', 'paused', 'recalibrating', 'ending'].includes(state.phase);
  const policyCheck = usePolicyCheck(selectedMode);

  useEffect(() => {
    if (!state.alert || document.hidden) return;
    const alert = state.alert;
    const frame = requestAnimationFrame(() =>
      measurement.confirmScreenAlert(alert.key, alert.stage),
    );
    return () => cancelAnimationFrame(frame);
  }, [state.alert]);

  return (
    <div className="measure-page">
      <div className="page-heading">
        <div>
          <div className="title-with-status">
            <h1>테스트 측정</h1>
            <span className="measure-badge">가상 입력</span>
          </div>
          <p className="page-description">
            가상 입력으로 측정·알림·저장 흐름이 잘 이어지는지 확인하는 화면이에요.
          </p>
        </div>
      </div>
      <Notice>
        AI 모델 연결 전 테스트입니다.
        {policyCheck.status === 'ok' &&
          (!policyCheck.server.release_approved ||
            policyCheck.server.camera_mapping_status !== 'validated') &&
          ' 판정 기준은 검증 전 초안이에요.'}
      </Notice>
      {state.error && <Notice kind="error">{state.error}</Notice>}
      {!running && policyCheck.status === 'error' && (
        <ErrorState error={policyCheck.message} retry={policyCheck.retry} />
      )}
      {!running && policyCheck.status === 'blocked' && (
        <Notice kind="error">{policyCheck.message}</Notice>
      )}
      {state.alert && <Notice>자세 확인 · {state.alert.stage}차 알림</Notice>}
      {state.phase === 'recalibrating' && (
        <Notice>기준 자세를 다시 잡고 있어요. 편한 자세로 3초 동안 가만히 있어 주세요.</Notice>
      )}
      <section className="panel service-panel measure-panel">
        <div className="service-controls">
          <Select<Mode>
            label="측정 방식"
            value={running ? state.mode : selectedMode}
            disabled={running}
            onChange={setSelectedMode}
            options={modeOptions}
          />
          <Select<Scenario>
            label="테스트 입력"
            value={state.scenario}
            onChange={(scenario) => useMeasurement.setState({ scenario })}
            options={scenarioOptions}
          />
          {/* 항상 기록으로 갈 수 있게 선택 칸 줄 오른쪽 끝에 고정. 방금 저장한 세션이 있으면 그 상세로 */}
          {state.phase === 'completed' && state.session ? (
            <Link
              to="/history/$sessionId"
              params={{ sessionId: state.session.id }}
              className="button button-secondary measure-record-link"
            >
              <History size={16} aria-hidden="true" />
              저장된 기록 보러가기
            </Link>
          ) : (
            <Link to="/history" className="button button-secondary measure-record-link">
              <History size={16} aria-hidden="true" />
              저장된 기록 보러가기
            </Link>
          )}
        </div>
        <div className="service-metrics">
          <div
            className={`measure-metric level-${state.phase === 'paused' || state.phase === 'recalibrating' ? 'idle' : (state.latest?.posture_level ?? 'idle')}`}
          >
            <span>
              <Gauge size={16} aria-hidden="true" />
              상태
            </span>
            <strong>
              <i className="measure-level-dot" aria-hidden="true" />
              {state.phase === 'paused'
                ? '일시정지'
                : state.phase === 'recalibrating'
                  ? '기준 재설정 중'
                  : state.latest
                    ? levelLabel[state.latest.posture_level]
                    : '대기'}
            </strong>
          </div>
          <div className="measure-metric">
            <span>
              <Timer size={16} aria-hidden="true" />
              시간
              {state.phase === 'active' && <i className="measure-live" aria-hidden="true" />}
            </span>
            <strong className="measure-number">
              {formatDuration(Math.max(0, state.elapsedMs - state.pausedMs))}
            </strong>
          </div>
          <div className="measure-metric">
            <span>
              <HardDriveUpload size={16} aria-hidden="true" />
              저장 대기
            </span>
            <strong className="measure-number">{state.pending}개</strong>
          </div>
        </div>
        <div className="button-row service-actions">
          {!running && (
            <Button
              disabled={policyCheck.status !== 'ok'}
              onClick={() => void measurement.start(selectedMode).catch(() => undefined)}
            >
              {policyCheck.status === 'loading' ? '정책 확인 중' : '시작'}
            </Button>
          )}
          {['active', 'paused'].includes(state.phase) && (
            <Button variant="secondary" onClick={() => measurement.pause()}>
              {state.phase === 'paused' ? '재개' : '일시정지'}
            </Button>
          )}
          {state.phase === 'paused' && (
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
          <Button variant="ghost" className="measure-mute" onClick={() => setMuted(!muted)}>
            {muted ? (
              <Bell size={16} aria-hidden="true" />
            ) : (
              <BellOff size={16} aria-hidden="true" />
            )}
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
    </div>
  );
}
