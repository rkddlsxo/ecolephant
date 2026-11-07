import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
} from '@tanstack/react-router';
import { Shell } from './components/Shell';
import { parsePeriodSearch } from './features/statistics/period';
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
const placeholderPages = () => import('./pages/PlaceholderPages');
const calibration = createRoute({
  getParentRoute: () => root,
  path: '/calibration',
  component: lazyRouteComponent(() => import('./pages/CalibrationPage'), 'CalibrationPage'),
});
const statistics = createRoute({
  getParentRoute: () => root,
  path: '/statistics',
  component: lazyRouteComponent(() => import('./pages/StatisticsPage'), 'StatisticsPage'),
});
const statisticsPeriod = createRoute({
  getParentRoute: () => root,
  path: '/statistics/period',
  validateSearch: parsePeriodSearch,
  component: lazyRouteComponent(
    () => import('./pages/StatisticsPeriodPage'),
    'StatisticsPeriodPage',
  ),
});
const notificationSettings = createRoute({
  getParentRoute: () => root,
  path: '/settings/notifications',
  component: lazyRouteComponent(placeholderPages, 'NotificationSettingsPage'),
});
const deviceSettings = createRoute({
  getParentRoute: () => root,
  path: '/settings/devices',
  component: lazyRouteComponent(placeholderPages, 'DeviceSettingsPage'),
});
const accountSettings = createRoute({
  getParentRoute: () => root,
  path: '/settings/account',
  component: lazyRouteComponent(placeholderPages, 'AccountSettingsPage'),
});
export const router = createRouter({
  routeTree: root.addChildren([
    prepare,
    calibration,
    measure,
    history,
    session,
    statistics,
    statisticsPeriod,
    notificationSettings,
    deviceSettings,
    accountSettings,
  ]),
  scrollRestoration: true,
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
