import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bell,
  CheckCircle2,
  CircleStop,
  CloudUpload,
  Pause,
  Play,
  RefreshCw,
  Timer,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { Scenario, Mode } from '@ecolephant/ai';
import { api } from '../api/client';
import { useMeasurement } from '../state/measurement';
import { usePreferences } from '../state/preferences';
import { measurement } from '../features/measurement/controller';
import { Button, formatDuration, modeLabel, Notice, Toggle } from '../components/ui';
import { PostureScene } from '../components/PostureScene';

const labels = {
  normal: '기준 범위 안이에요',
  caution: '자세를 한 번 살펴봐요',
  high: '잠깐, 자세를 바꿔볼까요?',
  unknown: '지금은 판단할 수 없어요',
};
const reason = {
  within_range: '기준 범위',
  combined_high: '두 신호가 모두 높음',
  forward_shift: '목의 전방 이동 신호',
  head_flexion: '머리 숙임 신호',
  mixed_caution: '센서 조합 주의',
  insufficient_data: '입력 부족',
  motion: '움직임이 큰 구간',
  calibrating: '데모 기준 재설정 중',
  paused: '일시정지 중',
};
const scenarios: { id: Scenario; name: string }[] = [
  { id: 'auto', name: '자동 시나리오' },
  { id: 'normal', name: '기준 범위' },
  { id: 'high', name: '높은 신호' },
  { id: 'head_down', name: '머리 숙임' },
  { id: 'camera_lost', name: '웹캠 신호 끊김' },
  { id: 'missing', name: '모든 신호 끊김' },
  { id: 'motion', name: '큰 움직임' },
  { id: 'manual', name: '각도 직접 조절' },
];
export function MeasurePage() {
  const state = useMeasurement();
  const navigate = useNavigate();
  const muted = usePreferences((s) => s.muted),
    setMuted = usePreferences((s) => s.setMuted);
  const [ending, setEnding] = useState(false);
  const saved = useQuery({
    queryKey: ['session-live', state.session?.id, state.saved],
    queryFn: () => api.session(state.session!.id),
    enabled: !!state.session,
  });
  const alert = state.alert;
  useEffect(() => {
    if (!alert) return;
    const frame = requestAnimationFrame(() =>
      measurement.confirmScreenAlert(alert.key, alert.stage),
    );
    return () => cancelAnimationFrame(frame);
  }, [alert]);
  async function finish() {
    setEnding(true);
    try {
      const session = await measurement.finish();
      if (session) await navigate({ to: '/history/$sessionId', params: { sessionId: session.id } });
    } catch {
      /* The ending state retains all unsent derived results. */
    } finally {
      setEnding(false);
    }
  }
  if (!state.session)
    return (
      <div className="empty-state">
        <Activity size={38} />
        <h2>먼저 데모 기준을 설정해 주세요.</h2>
        <Button onClick={() => navigate({ to: '/' })}>준비 화면으로</Button>
      </div>
    );
  const latest = state.latest,
    level = latest?.posture_level ?? 'unknown';
  const summary = saved.data?.summaries.find(
    (s) =>
      s.active_mode ===
      (latest?.active_mode === 'none' ? state.mode : (latest?.active_mode ?? state.mode)),
  );
  const metrics = summary?.metrics;
  const active = !['ending', 'completed'].includes(state.phase);
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">나의 자세, 지금 이 순간</span>
          <h1>실시간 데모 측정</h1>
          <p>화면의 신호는 예시 데이터입니다. 실제 자세를 측정하지 않습니다.</p>
        </div>
        <div className="session-clock">
          <Timer size={17} />
          {formatDuration(state.elapsedMs)}
        </div>
      </div>
      {state.error && (
        <Notice kind="error">
          {state.error}{' '}
          <button
            className="text-button"
            disabled={state.saving}
            onClick={() =>
              void (state.phase === 'ending'
                ? finish()
                : measurement.flush().catch(() => undefined))
            }
          >
            저장 재시도
          </button>
        </Notice>
      )}
      {state.memoryFull && (
        <Notice kind="error">
          보관 한도에 도달했어요. 새 상세 신호 수집을 멈췄으며, 연결 복구 후 중단 구간은 판단 불가로
          저장됩니다. 창을 닫으면 미전송 결과가 사라집니다.
        </Notice>
      )}
      {state.phase === 'ending' && (
        <Notice>측정을 종료했어요. 마지막 전송과 종료 승인이 끝나야 저장이 완료됩니다.</Notice>
      )}
      {alert && (
        <div className="posture-alert" role="alert">
          <Bell size={23} />
          <div>
            <strong>
              {alert.stage === 1
                ? '어깨에 힘을 빼고 자세를 살펴보세요.'
                : '잠깐 쉬면서 화면 높이와 앉은 위치를 조절해 보세요.'}
            </strong>
            <p>데모 신호의 지속 조건에 따라 표시된 {alert.stage}차 알림입니다.</p>
          </div>
        </div>
      )}
      <div className="measure-layout">
        <section className={`panel live-scene level-${level}`}>
          <div className="live-toolbar">
            <span className="badge white">
              <span className={active ? 'pulse-dot' : 'dot'} />
              {state.phase === 'paused'
                ? '일시정지'
                : state.phase === 'recalibrating'
                  ? '재설정 중'
                  : state.phase === 'ending'
                    ? '저장 대기'
                    : '데모 입력'}
            </span>
            <span>{modeLabel[latest?.active_mode ?? state.mode]}</span>
          </div>
          <PostureScene level={level} />
          <div className="live-status">
            <span className="status-dot" />
            <h2>{state.phase === 'paused' ? '잠시 쉬어가고 있어요' : labels[level]}</h2>
            <p>{latest ? reason[latest.reason_code] : '첫 신호를 기다리고 있어요.'}</p>
          </div>
        </section>
        <section className="panel signal-panel">
          <div className="section-heading">
            <h2>센서별 예시 신호</h2>
            <span className="badge neutral">가상 데이터</span>
          </div>
          <div className="angle-main">
            <span>참고 종합값</span>
            <strong>
              {latest?.display_angle_deg == null ? '—' : latest.display_angle_deg.toFixed(1)}
              <small>°</small>
            </strong>
            <p>판정은 두 신호의 조합으로 계산해요.</p>
          </div>
          <div className="sensor-values">
            <div>
              <span>웹캠 전방 이동</span>
              <strong>
                {latest?.camera_estimate_deg == null
                  ? '—'
                  : `${latest.camera_estimate_deg.toFixed(1)}°`}
              </strong>
            </div>
            <div>
              <span>AirPods 머리 숙임</span>
              <strong>
                {latest?.head_flexion_deg == null ? '—' : `${latest.head_flexion_deg.toFixed(1)}°`}
              </strong>
            </div>
          </div>
          <div className="signal-footnote">
            0°와 신호 누락은 달라요. 판단할 수 없는 구간은 ‘—’로 표시합니다.
          </div>
          <Toggle label="화면 알림 받기" checked={!muted} onChange={(v) => setMuted(!v)} />
        </section>
      </div>
      <div className="metric-grid">
        <div className="metric-card">
          <span>서버에 저장된 유효 시간</span>
          <strong>{metrics ? formatDuration(metrics.valid_duration_ms) : '—'}</strong>
          <small>현재 방식의 승인된 창 기준</small>
        </div>
        <div className="metric-card">
          <span>기준 범위 비율</span>
          <strong>
            {metrics?.within_range_percent == null
              ? '—'
              : `${metrics.within_range_percent.toFixed(1)}%`}
          </strong>
          <small>판단 불가·일시정지 제외</small>
        </div>
        <div className="metric-card">
          <span>1차 알림</span>
          <strong>
            {metrics?.first_stage_alert_count ?? 0}
            <em>회</em>
          </strong>
          <small>화면 표시가 확인된 알림</small>
        </div>
      </div>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>최근 예시 신호</h2>
            <p>최대 120개 창 · 회색 구간은 판단 불가</p>
          </div>
          <div className="legend">
            <span className="legend-normal">기준 범위</span>
            <span className="legend-caution">주의</span>
            <span className="legend-high">높음</span>
            <span className="legend-unknown">판단 불가</span>
          </div>
        </div>
        <div className="signal-timeline" aria-label="최근 창별 자세 상태">
          {state.recent.length ? (
            state.recent.map((s) => (
              <span
                key={s.seq}
                className={`timeline-tick level-${s.posture_level}`}
                title={`${formatDuration(s.elapsed_start_ms)} · ${reason[s.reason_code]}`}
              />
            ))
          ) : (
            <p className="muted">첫 번째 창을 기다리고 있어요.</p>
          )}
        </div>
      </section>
      <section className="panel simulator-panel">
        <div>
          <h2>데모 입력 바꾸기</h2>
          <p>가상 신호로 상태 변화와 알림을 체험해 보세요.</p>
        </div>
        <label>
          시나리오
          <select
            value={state.scenario}
            disabled={!active}
            onChange={(e) => useMeasurement.setState({ scenario: e.target.value as Scenario })}
          >
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          측정 방식
          <select
            value={state.mode}
            disabled={!active || state.phase === 'recalibrating' || state.pending > 550}
            onChange={(e) => measurement.recalibrate(e.target.value as Mode)}
          >
            {(['combined', 'webcam', 'airpods'] as const).map((mode) => (
              <option key={mode} value={mode}>
                {modeLabel[mode]}
              </option>
            ))}
          </select>
        </label>
        {state.scenario === 'manual' && (
          <div className="sliders">
            <label>
              웹캠 {state.camera}°
              <input
                type="range"
                min="0"
                max="90"
                value={state.camera}
                disabled={!active}
                onChange={(e) => useMeasurement.setState({ camera: Number(e.target.value) })}
              />
            </label>
            <label>
              AirPods {state.head}°
              <input
                type="range"
                min="0"
                max="90"
                value={state.head}
                disabled={!active}
                onChange={(e) => useMeasurement.setState({ head: Number(e.target.value) })}
              />
            </label>
          </div>
        )}
      </section>
      <div className="measurement-footer">
        <div className="sync-status">
          {state.pending === 0 ? <CheckCircle2 size={17} /> : <CloudUpload size={17} />}
          <span>
            {state.saving
              ? '전송 중…'
              : state.pending
                ? `${state.pending}개 전송 대기`
                : '모든 결과 전송 완료'}
            <small>페이지를 닫으면 미전송 결과는 사라집니다.</small>
          </span>
        </div>
        <div className="button-row">
          <Button
            variant="secondary"
            disabled={!active || state.phase === 'recalibrating' || state.pending > 550}
            onClick={() => measurement.pause()}
          >
            {state.phase === 'paused' ? <Play size={16} /> : <Pause size={16} />}{' '}
            {state.phase === 'paused' ? '재개' : '일시정지'}
          </Button>
          <Button
            variant="secondary"
            disabled={!active || state.phase === 'recalibrating' || state.pending > 550}
            onClick={() => measurement.recalibrate()}
          >
            <RefreshCw size={16} />
            재설정
          </Button>
          <Button disabled={ending || state.phase === 'completed'} onClick={finish}>
            <CircleStop size={17} />
            {ending ? '저장 중…' : state.phase === 'ending' ? '종료 저장 재시도' : '종료하고 저장'}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
