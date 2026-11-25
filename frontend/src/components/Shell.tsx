import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useIsMutating, useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bell,
  Camera,
  ChartLine,
  Cpu,
  Crosshair,
  History,
  PersonStanding,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { api } from '../api/client';
import { useMeasurement } from '../state/measurement';
import { useAuth } from '../features/auth/AuthContext';
import { stopBackgroundCamera, useBackgroundCamera } from '../features/camera/background-camera';
import { Button } from './ui';

export function Shell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const phase = useMeasurement((state) => state.phase);
  const auth = useAuth();
  const mutations = useIsMutating();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 15000,
    enabled: auth.kind !== 'preview',
  });
  const running = ['starting', 'active', 'paused', 'recalibrating', 'ending'].includes(phase);
  const backgroundCamera = useBackgroundCamera((state) => state.on);

  const navigation = [
    {
      title: '측정하기',
      items: [
        { to: '/', label: '카메라 확인', Icon: Camera },
        { to: '/calibration', label: '표준 자세 등록', Icon: Crosshair },
        { to: '/measure', label: '사용자 측정', Icon: Activity },
      ],
    },
    {
      title: '돌아보기',
      items: [
        { to: '/history', label: '세션 기록', Icon: History },
        { to: '/statistics', label: '통계·추이', Icon: ChartLine },
      ],
    },
    {
      title: '설정',
      items: [
        { to: '/settings/notifications', label: '알림', Icon: Bell },
        { to: '/settings/devices', label: '장치·센서', Icon: Cpu },
        { to: '/settings/account', label: '개인정보·계정', Icon: UserRound },
      ],
    },
  ] as const;
  return (
    <div className="service-shell">
      <header className="service-header">
        <Link to="/" className="service-brand">
          <span className="service-brand-mark" aria-hidden="true">
            <PersonStanding size={20} strokeWidth={2.4} />
          </span>
          <span className="service-brand-text">
            <span className="service-brand-name">ECOLEPHANT</span>
            <span className="service-brand-tagline">에코끼리 · 편안한 자세의 시작</span>
          </span>
        </Link>
        {auth.kind !== 'preview' && (
          <span
            className={`service-connection ${health.isPending ? 'pending' : health.isSuccess ? 'ok' : 'error'}`}
            role="status"
          >
            <span className="service-connection-dot" aria-hidden="true" />
            {health.isPending
              ? '서버 확인 중'
              : health.isSuccess
                ? '서버 연결됨'
                : '서버 연결 안 됨'}
          </span>
        )}
        {auth.kind === 'cognito' && (
          <Button
            variant="ghost"
            disabled={running || mutations > 0}
            onClick={() => void auth.signOut()}
          >
            로그아웃
          </Button>
        )}
      </header>
      <div className="service-body">
        <aside className="service-sidebar">
          <div className="service-sidebar-inner">
            <nav className="service-sidebar-navigation" aria-label="주요 메뉴">
              {navigation.map(({ title, items }) => (
                <section key={title} className="service-nav-group" aria-label={title}>
                  <h2 className="service-nav-group-title">{title}</h2>
                  {items.map((item) => {
                    const { to, label, Icon } = item;
                    if ('disabled' in item && item.disabled) {
                      return (
                        <span
                          key={to}
                          className="service-nav-link is-disabled"
                          aria-disabled="true"
                        >
                          <Icon size={18} aria-hidden="true" />
                          {label}
                          <span className="service-nav-soon">준비 중</span>
                        </span>
                      );
                    }
                    return (
                      <Link
                        key={to}
                        to={to}
                        className={`service-nav-link ${to === '/' ? (pathname === '/' ? 'selected' : '') : pathname.startsWith(to) ? 'selected' : ''}`}
                      >
                        <Icon size={18} aria-hidden="true" />
                        {label}
                        {to === '/measure' && running && (
                          <span className="service-nav-live">측정 중</span>
                        )}
                      </Link>
                    );
                  })}
                </section>
              ))}
            </nav>
            <p className="service-sidebar-note">
              <ShieldCheck size={16} aria-hidden="true" />
              카메라 영상은 서버로 보내지 않아요.
            </p>
          </div>
        </aside>
        <main id="main-content" className="service-main">
          {/* 측정 화면은 자체 안내 자리에 카메라 상태와 끄기 버튼을 보여 준다 */}
          {backgroundCamera && pathname !== '/measure' && (
            <div className="background-camera-bar" role="status">
              <span className="background-camera-dot" aria-hidden="true" />
              <span className="background-camera-text">
                {running ? '측정 중 · 카메라 켜짐' : '카메라 켜짐 · 표준 자세 등록됨'}
                <small>
                  {running
                    ? '다른 메뉴에 있어도 이 브라우저 안에서 자세 분석이 계속돼요. 영상은 밖으로 보내지 않아요.'
                    : '측정 화면에서 시작을 누르면 이 카메라로 바로 측정해요. 영상은 밖으로 보내지 않아요.'}
                </small>
              </span>
              <span className="button-row">
                <Link to="/measure" className="button button-secondary">
                  측정 화면으로
                </Link>
                <Button variant="secondary" onClick={stopBackgroundCamera}>
                  카메라 끄기
                </Button>
              </span>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
