import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useIsMutating, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useMeasurement } from '../state/measurement';
import { useAuth } from '../features/auth/AuthContext';
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

  const navigation = [
    { to: '/', label: '카메라' },
    { to: '/measure', label: '테스트 측정' },
    { to: '/history', label: '기록' },
  ] as const;
  return (
    <div className="service-shell">
      <header className="service-header">
        <Link to="/" className="service-brand">
          에코끼리
        </Link>
        <nav className="service-navigation" aria-label="주요 메뉴">
          {navigation.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={`service-nav-link ${to === '/' ? (pathname === '/' ? 'selected' : '') : pathname.startsWith(to) ? 'selected' : ''}`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <span className="service-connection" role="status">
          {auth.kind === 'preview'
            ? '미리보기'
            : health.isPending
              ? '서버 확인 중'
              : health.isSuccess
                ? '서버 연결됨'
                : '서버 연결 안 됨'}
        </span>
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
      <main id="main-content" className="service-main">
        {running && pathname !== '/measure' && (
          <Link to="/measure" className="active-session-link">
            테스트 측정 진행 중 · 돌아가기
          </Link>
        )}
        <Outlet />
      </main>
    </div>
  );
}
