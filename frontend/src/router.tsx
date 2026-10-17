import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
} from '@tanstack/react-router';
import { Shell } from './components/Shell';
const root = createRootRoute({
  component: Shell,
  notFoundComponent: () => (
    <div className="empty-state">
      <h1>페이지를 찾을 수 없어요.</h1>
      <Link to="/">준비 화면으로 돌아가기</Link>
    </div>
  ),
});
const prepare = createRoute({
  getParentRoute: () => root,
  path: '/',
  component: lazyRouteComponent(() => import('./pages/PreparePage'), 'PreparePage'),
});
const measure = createRoute({
  getParentRoute: () => root,
  path: '/measure',
  component: lazyRouteComponent(() => import('./pages/MeasurePage'), 'MeasurePage'),
});
const history = createRoute({
  getParentRoute: () => root,
  path: '/history',
  component: lazyRouteComponent(() => import('./pages/HistoryPage'), 'HistoryPage'),
});
const session = createRoute({
  getParentRoute: () => root,
  path: '/history/$sessionId',
  component: lazyRouteComponent(() => import('./pages/SessionPage'), 'SessionPage'),
});
export const router = createRouter({
  routeTree: root.addChildren([prepare, measure, history, session]),
  scrollRestoration: true,
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
