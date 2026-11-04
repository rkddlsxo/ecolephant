import { describe, expect, it } from 'vitest';
import { resolveAuthConfig } from './config';

describe('authentication configuration', () => {
  const loopback = 'http://127.0.0.1:5173';

  it('preserves the existing loopback-only local development flow', () => {
    expect(
      resolveAuthConfig({ DEV: true, VITE_LOCAL_TOKEN: 'local-test-token' }, loopback),
    ).toEqual({
      kind: 'local',
      token: 'local-test-token',
      apiBaseUrl: '',
    });
  });

  it('allows camera-only preview on loopback without a backend token', () => {
    expect(resolveAuthConfig({ DEV: true }, loopback)).toEqual({ kind: 'preview', apiBaseUrl: '' });
    expect(resolveAuthConfig({ DEV: true }, 'https://remote.example.invalid').kind).toBe(
      'unavailable',
    );
  });

  it('never enables a local token in a production build or on a remote origin', () => {
    const production = resolveAuthConfig(
      { DEV: false, VITE_LOCAL_TOKEN: 'local-test-token' },
      loopback,
    );
    const remoteOrigin = resolveAuthConfig(
      { DEV: true, VITE_LOCAL_TOKEN: 'local-test-token' },
      'https://example.invalid',
    );
    const remoteApi = resolveAuthConfig(
      {
        DEV: true,
        VITE_LOCAL_TOKEN: 'local-test-token',
        VITE_API_BASE_URL: 'https://example.invalid',
      },
      loopback,
    );
    for (const result of [production, remoteOrigin, remoteApi]) {
      expect(result.kind).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain('local-test-token');
    }
  });

  it('requires valid public pool configuration and a secure API address', () => {
    const env = {
      DEV: false,
      VITE_AUTH_MODE: 'cognito',
      VITE_COGNITO_USER_POOL_ID: 'ap-northeast-2_Example1',
      VITE_COGNITO_CLIENT_ID: 'exampleclient',
      VITE_API_BASE_URL: 'https://api.example.invalid',
    };
    expect(resolveAuthConfig(env, 'https://app.example.invalid')).toEqual({
      kind: 'cognito',
      userPoolId: env.VITE_COGNITO_USER_POOL_ID,
      clientId: env.VITE_COGNITO_CLIENT_ID,
      apiBaseUrl: env.VITE_API_BASE_URL,
    });
    expect(
      resolveAuthConfig({ ...env, VITE_COGNITO_CLIENT_ID: '' }, 'https://app.example.invalid').kind,
    ).toBe('unavailable');
    expect(
      resolveAuthConfig(
        { ...env, VITE_API_BASE_URL: 'http://api.example.invalid' },
        'https://app.example.invalid',
      ).kind,
    ).toBe('unavailable');
    expect(
      resolveAuthConfig(
        { ...env, VITE_API_BASE_URL: 'https://user:password@api.example.invalid' },
        'https://app.example.invalid',
      ).kind,
    ).toBe('unavailable');
    expect(
      resolveAuthConfig({ ...env, VITE_AUTH_MODE: 'unexpected' }, 'https://app.example.invalid')
        .kind,
    ).toBe('unavailable');
  });

  it('rejects loopback APIs from a public Cognito page, including alternate loopback names', () => {
    const env = {
      DEV: false,
      VITE_AUTH_MODE: 'cognito',
      VITE_COGNITO_USER_POOL_ID: 'ap-northeast-2_Example1',
      VITE_COGNITO_CLIENT_ID: 'exampleclient',
    };
    const localApis = [
      'http://127.0.0.1:5000',
      'https://127.0.0.2',
      'https://0.0.0.0',
      'https://[::]',
      'https://localhost.',
      'https://app.localhost',
      'https://[::1]',
      'https://[::ffff:127.0.0.1]',
    ];
    for (const DEV of [true, false]) {
      for (const VITE_API_BASE_URL of localApis) {
        expect(
          resolveAuthConfig({ ...env, DEV, VITE_API_BASE_URL }, 'https://app.example.invalid').kind,
        ).toBe('unavailable');
      }
    }
  });

  it('does not mistake a public hostname beginning with 127 for a loopback address', () => {
    expect(
      resolveAuthConfig(
        {
          DEV: false,
          VITE_AUTH_MODE: 'cognito',
          VITE_COGNITO_USER_POOL_ID: 'ap-northeast-2_Example1',
          VITE_COGNITO_CLIENT_ID: 'exampleclient',
          VITE_API_BASE_URL: 'https://127.example.invalid',
        },
        'https://app.example.invalid',
      ).kind,
    ).toBe('cognito');
  });

  it('requires HTTPS in a production build while preserving loopback development', () => {
    const env = {
      VITE_AUTH_MODE: 'cognito',
      VITE_COGNITO_USER_POOL_ID: 'ap-northeast-2_Example1',
      VITE_COGNITO_CLIENT_ID: 'exampleclient',
      VITE_API_BASE_URL: 'http://127.0.0.1:5000',
    };
    expect(resolveAuthConfig({ ...env, DEV: false }, loopback).kind).toBe('unavailable');
    expect(resolveAuthConfig({ ...env, DEV: true }, loopback).kind).toBe('cognito');
    expect(
      resolveAuthConfig(
        { ...env, DEV: true, VITE_API_BASE_URL: 'https://api.example.invalid' },
        loopback,
      ).kind,
    ).toBe('cognito');
  });
});
