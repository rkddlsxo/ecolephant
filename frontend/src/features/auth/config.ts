export interface AuthEnvironment {
  DEV: boolean;
  VITE_AUTH_MODE?: string;
  VITE_LOCAL_TOKEN?: string;
  VITE_API_BASE_URL?: string;
  VITE_COGNITO_USER_POOL_ID?: string;
  VITE_COGNITO_CLIENT_ID?: string;
}

export type AuthConfig =
  | { kind: 'preview'; apiBaseUrl: string }
  | { kind: 'local'; token: string; apiBaseUrl: string }
  | { kind: 'cognito'; userPoolId: string; clientId: string; apiBaseUrl: string }
  | { kind: 'unavailable' };

function loopback(url: URL) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function loopbackDestination(url: URL) {
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === '0.0.0.0' ||
    host === '[::]' ||
    host === '[::1]' ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
  );
}

function safeAddress(raw: string, origin: string) {
  try {
    const url = new URL(raw || '/', origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export function resolveAuthConfig(env: AuthEnvironment, origin: string): AuthConfig {
  const unavailable: AuthConfig = { kind: 'unavailable' };
  const page = safeAddress('', origin);
  const apiBaseUrl = env.VITE_API_BASE_URL?.trim() ?? '';
  const api = safeAddress(apiBaseUrl, origin);
  if (!page || !api) return unavailable;

  const mode = env.VITE_AUTH_MODE || (env.DEV ? (env.VITE_LOCAL_TOKEN ? 'local' : 'preview') : '');
  if (mode === 'preview') {
    if (!env.DEV || !loopback(page) || !loopback(api)) return unavailable;
    return { kind: 'preview', apiBaseUrl };
  }
  if (mode === 'local') {
    const token = env.VITE_LOCAL_TOKEN?.trim();
    if (!env.DEV || !token || !loopback(page) || !loopback(api)) return unavailable;
    return { kind: 'local', token, apiBaseUrl };
  }
  if (mode === 'cognito') {
    const userPoolId = env.VITE_COGNITO_USER_POOL_ID?.trim() ?? '';
    const clientId = env.VITE_COGNITO_CLIENT_ID?.trim() ?? '';
    if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d_[A-Za-z0-9]+$/.test(userPoolId)) return unavailable;
    if (!/^[A-Za-z0-9]{1,128}$/.test(clientId)) return unavailable;
    if (!env.DEV && !apiBaseUrl) return unavailable;
    if (page.protocol !== 'https:' && !loopback(page)) return unavailable;
    if (loopbackDestination(api) && !loopback(page)) return unavailable;
    if (api.protocol !== 'https:' && !(env.DEV && loopback(page) && loopback(api)))
      return unavailable;
    return { kind: 'cognito', userPoolId, clientId, apiBaseUrl };
  }
  return unavailable;
}
