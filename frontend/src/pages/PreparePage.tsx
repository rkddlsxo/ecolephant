import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import {
  ArrowRight,
  Camera,
  Check,
  CheckCircle2,
  Headphones,
  Layers,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { usePreferences } from '../state/preferences';
import { useMeasurement } from '../state/measurement';
import { measurement } from '../features/measurement/controller';
import { Button, ErrorState, Notice } from '../components/ui';
import { PostureScene } from '../components/PostureScene';
import { CameraPreview } from '../components/CameraPreview';

const schema = z.object({
  mode: z.enum(['webcam', 'airpods', 'combined']),
  consent: z.boolean().refine((v) => v, '데모 데이터 저장 안내를 확인해 주세요.'),
});
type Values = z.infer<typeof schema>;
const modes = [
  {
    id: 'combined',
    icon: Layers,
    name: '웹캠 + AirPods',
    text: '두 신호를 조합한 판정을 체험해요.',
    tag: '결합 데모',
  },
  {
    id: 'webcam',
    icon: Camera,
    name: '웹캠',
    text: '목의 전방 이동 신호를 체험해요.',
    tag: '웹캠 데모',
  },
  {
    id: 'airpods',
    icon: Headphones,
    name: 'AirPods',
    text: '머리 숙임 신호를 체험해요.',
    tag: '숙임 데모',
  },
] as const;

export function PreparePage() {
  const navigate = useNavigate();
  const preferred = usePreferences((s) => s.mode);
  const setPreferred = usePreferences((s) => s.setMode);
  const phase = useMeasurement((s) => s.phase);
  const runtimeError = useMeasurement((s) => s.error);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { mode: preferred, consent: false },
  });
  const mode = useWatch({ control, name: 'mode' });
  const [countdown, setCountdown] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const policies = useQuery({ queryKey: ['policies'], queryFn: api.policies });
  useEffect(() => {
    setReady(false);
    setCountdown(null);
  }, [mode]);
  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      setReady(true);
      setCountdown(null);
      return;
    }
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);
  async function submit(values: Values) {
    if (!ready || !policies.data) return;
    setPreferred(values.mode);
    try {
      await measurement.start(values.mode);
      await navigate({ to: '/measure' });
    } catch {
      /* The controller keeps the same creation key for the retry. */
    }
  }
  if (['active', 'paused', 'recalibrating', 'ending'].includes(phase))
    return (
      <div className="empty-state">
        <h2>진행 중인 측정이 있어요.</h2>
        <Button onClick={() => navigate({ to: '/measure' })}>측정 화면으로 돌아가기</Button>
      </div>
    );
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">나를 위한 작은 루틴</span>
          <h1>오늘도, 편안한 자세로.</h1>
          <p>잠깐 준비하고 내 자세 습관을 살펴보세요.</p>
        </div>
        <span className="badge outline">
          <Sparkles size={14} /> 1차 MVP · 데모
        </span>
      </div>
      {policies.isError && (
        <ErrorState error={errorMessage(policies.error)} retry={() => void policies.refetch()} />
      )}
      {runtimeError && <Notice kind="error">{runtimeError}</Notice>}
      <div className="prepare-layout">
        <form onSubmit={handleSubmit(submit)} className="prepare-form">
          <section className="panel">
            <div className="section-heading">
              <span className="step-number">01</span>
              <div>
                <h2>측정 방식 선택</h2>
                <p>현재 모든 방식은 가상 입력으로 동작합니다.</p>
              </div>
            </div>
            <div className="mode-options">
              {modes.map(({ id, icon: Icon, name, text, tag }) => (
                <label key={id} className={`mode-option ${mode === id ? 'selected' : ''}`}>
                  <input type="radio" value={id} {...register('mode')} className="sr-only" />
                  <span className="mode-icon">
                    <Icon size={22} />
                  </span>
                  <span className="mode-copy">
                    <strong>{name}</strong>
                    <small>{text}</small>
                  </span>
                  <span className="mode-side">
                    <span className="badge neutral">{tag}</span>
                    <span className="radio-indicator">{mode === id && <Check size={12} />}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="section-heading">
              <span className="step-number">02</span>
              <div>
                <h2>데모 기준 설정</h2>
                <p>실제 센서 보정은 후속 연결 단계에서 제공됩니다.</p>
              </div>
            </div>
            <div className={`calibration-box ${ready ? 'is-ready' : ''}`}>
              <div className="calibration-symbol">
                {ready ? (
                  <CheckCircle2 size={27} />
                ) : countdown !== null ? (
                  <span>{countdown}</span>
                ) : (
                  <span>
                    3<span className="tiny">초</span>
                  </span>
                )}
              </div>
              <div>
                <strong>
                  {ready
                    ? '데모 기준 설정 완료'
                    : countdown !== null
                      ? '데모 기준을 준비하고 있어요.'
                      : '3초 동안 준비해 주세요.'}
                </strong>
                <p>
                  {ready
                    ? '이제 예시 신호로 측정을 시작할 수 있어요.'
                    : '기기를 연결하거나 실제 자세를 수집하지 않습니다.'}
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={countdown !== null || phase === 'starting'}
                onClick={() => {
                  setReady(false);
                  setCountdown(3);
                }}
              >
                {ready ? '다시 설정' : '기준 설정'}
              </Button>
            </div>
          </section>
          <section className="panel start-panel">
            <label className="consent">
              <input type="checkbox" {...register('consent')} />
              <span>
                예시 각도·상태·시간만 로컬에 저장되는 데모임을 확인했어요.
                <small>실제 영상·관절점·원시 센서 데이터는 저장하지 않습니다.</small>
              </span>
            </label>
            {errors.consent && (
              <p className="field-error" role="alert">
                {errors.consent.message}
              </p>
            )}
            <Button
              type="submit"
              className="start-button"
              disabled={!ready || !policies.data || phase === 'starting'}
            >
              {phase === 'starting' ? '세션을 준비하고 있어요…' : '데모 측정 시작'}
              <ArrowRight size={18} />
            </Button>
          </section>
        </form>
        <aside className="prepare-aside">
          <div className="illustration-card">
            <span className="badge white">가벼운 시작, 꾸준한 변화</span>
            <PostureScene />
            <div>
              <h3>숫자보다, 내 습관을 알아가는 시간</h3>
              <p>
                목의 전방 이동과 머리 숙임을 구분해 살펴봐요.
                <br />
                결과는 의료 진단이 아닌 참고 정보입니다.
              </p>
            </div>
          </div>
          <div className="privacy-card">
            <ShieldCheck size={23} />
            <div>
              <strong>내 영상은 내 기기에만</strong>
              <p>서버에는 허용된 파생 결과만 전송합니다. 아래 미리보기도 업로드되지 않아요.</p>
            </div>
          </div>
          <div className="demo-note">
            <strong>이번 버전에서 할 수 있어요</strong>
            <p>방식 선택 → 데모 기준 설정 → 실시간 판정 → 종료·저장 → 기록 조회·삭제</p>
          </div>
        </aside>
      </div>
      <CameraPreview />
    </motion.div>
  );
}
