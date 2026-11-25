import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { policy, type Level, type Mode } from '@ecolephant/ai';
import {
  Bell,
  BellOff,
  CameraOff,
  Crosshair,
  Gauge,
  HardDriveUpload,
  History,
  Timer,
} from 'lucide-react';
import { Button, ErrorState, formatDuration, Modal, Notice } from '../components/ui';
import { stopBackgroundCamera, useBackgroundCamera } from '../features/camera/background-camera';
import { useAirPods } from '../features/measurement/airpods/airpods-link';
import { useCameraPipeline } from '../features/measurement/camera-pipeline';
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
/**
 * One label for any detected type (2026-11-21): the front-camera type (chin forward / head down /
 * both) was unreliable in the test videos, so only the level is shown with "거북목 자세".
 * The type is still recorded with each window.
 */
const postureLabel = '거북목 자세';

const changeThresholds = policy.camera_change_thresholds;
const signed = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;

export function MeasurePage() {
  const state = useMeasurement();
  const muted = usePreferences((value) => value.muted);
  const setMuted = usePreferences((value) => value.setMuted);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const running = ['starting', 'active', 'paused', 'recalibrating', 'ending'].includes(state.phase);
  const camera = state.input === 'camera';
  const pipeline = useCameraPipeline();
  const airpods = useAirPods();
  // The page measures with the real camera only. The camera is turned on and the baseline taken
  // on the calibration page; the background camera keeps it running here (no preview).
  // Test input (synthetic signals) stays in the controller for automated tests only.
  const mode: Mode = 'webcam';
  const policyCheck = usePolicyCheck(mode);
  const cameraReady = !camera || (pipeline.status === 'running' && pipeline.hasBaseline);
  // The camera kept on from the calibration page (or during the measurement).
  const cameraOn = useBackgroundCamera((value) => value.on);

  useEffect(() => {
    const current = useMeasurement.getState();
    if (
      current.input !== 'camera' &&
      !['starting', 'active', 'paused', 'recalibrating', 'ending'].includes(current.phase)
    )
      useMeasurement.setState({ input: 'camera', error: null });
  }, []);

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
            <h1>사용자 측정</h1>
            <span className="measure-badge">{camera ? '기준값 검증 전' : '가상 입력'}</span>
          </div>
          <p className="page-description">
            {camera
              ? '웹캠으로 표준 자세에서 얼마나 달라졌는지 판정해요. 기록은 검증 전 연습용으로 저장돼요.'
              : '가상 입력으로 측정·알림·저장 흐름이 잘 이어지는지 확인하는 화면이에요.'}
          </p>
        </div>
      </div>
      <Notice>
        {camera
          ? '영상과 관절점은 이 기기에서만 분석하고, 서버에는 판정 결과와 변화량 숫자만 보내요.'
          : '가상 입력으로 하는 테스트입니다.'}
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
        <Notice>
          표준 자세를 다시 등록하고 있어요. 편한 자세로 3초 동안 가만히 있어 주세요.
          {camera && ` (${Math.round(pipeline.progress * 100)}%)`}
        </Notice>
      )}
      {/* 카메라 상태는 이 한 자리에서: 켜져 있으면 끄기, 꺼져 있거나 기준이 없으면 보정 안내 */}
      {camera && cameraOn && (
        <div className="notice background-camera-notice" role="status">
          <span className="measure-calibration-note">
            <span className="measure-camera-on">
              <span className="background-camera-dot" aria-hidden="true" />
              {running
                ? '측정 중 · 카메라 켜짐. 다른 메뉴로 옮겨도 이 브라우저 안에서 자세 분석이 계속돼요.'
                : '카메라 켜짐 · 표준 자세 등록됨. 시작을 누르면 이 카메라로 바로 측정해요.'}
            </span>
            <button
              type="button"
              className="button button-secondary measure-record-link background-camera-off"
              onClick={stopBackgroundCamera}
            >
              <CameraOff size={16} aria-hidden="true" />
              카메라 끄기
            </button>
          </span>
        </div>
      )}
      {camera && !cameraOn && (running ? pipeline.status !== 'running' : !cameraReady) && (
        <Notice>
          <span className="measure-calibration-note">
            {running
              ? '카메라가 꺼져 있어 지금은 판단 불가로 기록돼요. 표준 자세 등록에서 카메라를 다시 켜 주세요.'
              : pipeline.status === 'running' || pipeline.status === 'loading'
                ? '아직 표준 자세가 없어요. 표준 자세 등록에서 표준 자세를 등록한 뒤 이 화면으로 돌아와 주세요.'
                : '카메라가 꺼져 있어요. 표준 자세 등록에서 카메라를 켜고 표준 자세를 등록한 뒤 이 화면으로 돌아와 주세요.'}
            <Link to="/calibration" className="measure-calibration-link">
              <Crosshair size={16} aria-hidden="true" />
              표준 자세 등록으로
            </Link>
          </span>
        </Notice>
      )}
      <section className="panel service-panel measure-panel">
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
                  ? '표준 자세 다시 등록 중'
                  : state.latest
                    ? `${levelLabel[state.latest.posture_level]}${state.latest.posture_type ? ` · ${postureLabel}` : ''}`
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
        {camera && changeThresholds && (
          <p className="measure-change-readout" data-testid="change-readout">
            표준 자세 대비 변화 · 앞쏠림{' '}
            {state.latest?.camera_forward_change != null
              ? signed(state.latest.camera_forward_change)
              : '—'}{' '}
            (주의 {signed(changeThresholds.forward.caution)}) · 귀 높이{' '}
            {state.latest?.camera_drop_change != null
              ? signed(state.latest.camera_drop_change)
              : '—'}{' '}
            (주의 {signed(changeThresholds.drop.caution)}) · 코 높이{' '}
            {state.latest?.camera_nose_drop_change != null
              ? signed(state.latest.camera_nose_drop_change)
              : '—'}{' '}
            (주의 {signed(changeThresholds.nose_drop.caution)})
          </p>
        )}
        <div className="button-row service-actions">
          {!running && (
            <Button
              disabled={
                policyCheck.status !== 'ok' ||
                !cameraReady ||
                pipeline.calibrating ||
                airpods.calibrating
              }
              onClick={() => void measurement.start(mode).catch(() => undefined)}
            >
              {policyCheck.status === 'loading'
                ? '정책 확인 중'
                : camera && !cameraReady
                  ? '표준 자세를 먼저 등록해 주세요'
                  : '시작'}
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
              표준 자세 다시 등록
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
          {/* 오른쪽 끝: 저장된 기록(방금 저장한 세션이 있으면 그 상세) · 알림 켜기/끄기 */}
          <span className="measure-actions-end">
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
            <Button variant="ghost" className="measure-mute" onClick={() => setMuted(!muted)}>
              {muted ? (
                <Bell size={16} aria-hidden="true" />
              ) : (
                <BellOff size={16} aria-hidden="true" />
              )}
              {muted ? '알림 켜기' : '알림 끄기'}
            </Button>
          </span>
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
