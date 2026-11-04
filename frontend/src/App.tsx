import { useEffect, useState } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import { setApiBaseUrl } from './api/client';
import { Loading } from './components/ui';
import { AuthBoundary } from './features/auth/AuthBoundary';
import { createAuthAdapter } from './features/auth/adapter';
import type { AuthAdapter } from './features/auth/adapter';
import { resolveAuthConfig } from './features/auth/config';
import { router } from './router';

const authConfig = resolveAuthConfig(
  {
    DEV: import.meta.env.DEV,
    VITE_LOCAL_TOKEN: import.meta.env.DEV ? import.meta.env.VITE_LOCAL_TOKEN : undefined,
    VITE_AUTH_MODE: import.meta.env.VITE_AUTH_MODE,
    VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
    VITE_COGNITO_USER_POOL_ID: import.meta.env.VITE_COGNITO_USER_POOL_ID,
    VITE_COGNITO_CLIENT_ID: import.meta.env.VITE_COGNITO_CLIENT_ID,
  },
  window.location.origin,
);
setApiBaseUrl(authConfig.kind === 'unavailable' ? '' : authConfig.apiBaseUrl);
const adapterPromise = createAuthAdapter(authConfig).catch(() => null);

export function App() {
  const [adapter, setAdapter] = useState<AuthAdapter | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void adapterPromise.then((value) => {
      if (active) setAdapter(value);
    });
    return () => {
      active = false;
    };
  }, []);
  if (adapter === undefined)
    return (
      <main className="auth-page">
        <Loading />
      </main>
    );
  return (
    <AuthBoundary adapter={adapter}>
      <RouterProvider router={router} />
    </AuthBoundary>
  );
}
