import { AxiosError } from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  http,
  isMissingSession,
  retry,
  setApiBaseUrl,
  setAuthFailureHandler,
  setTokenProvider,
} from './client';

describe('authenticated API transport', () => {
  const originalAdapter = http.defaults.adapter;
  const send = vi.fn(async (config: InternalAxiosRequestConfig) => ({
    data: {},
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  }));
  const onAuthFailure = vi.fn();

  beforeEach(() => {
    setApiBaseUrl('https://api.example.invalid');
    setTokenProvider(async () => 'synthetic-access-token');
    setAuthFailureHandler(onAuthFailure);
    http.defaults.adapter = send;
  });
  afterEach(() => {
    vi.useRealTimers();
    http.defaults.adapter = originalAdapter;
    setApiBaseUrl('');
    setTokenProvider(null);
    setAuthFailureHandler(null);
    vi.clearAllMocks();
  });

  it('sends a fresh token only to the configured API', async () => {
    await http.get('/api/v1/sessions');
    expect(send.mock.calls[0][0].headers.Authorization).toBe('Bearer synthetic-access-token');
    await expect(http.get('https://untrusted.invalid/steal')).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads the current token separately for each request', async () => {
    const provider = vi
      .fn()
      .mockResolvedValueOnce('first-token')
      .mockResolvedValueOnce('refreshed-token');
    setTokenProvider(provider);
    await http.get('/api/v1/sessions');
    await http.get('/api/v1/sessions');
    expect(send.mock.calls[0][0].headers.Authorization).toBe('Bearer first-token');
    expect(send.mock.calls[1][0].headers.Authorization).toBe('Bearer refreshed-token');
  });

  it('allows health without a token but blocks other requests when login expires', async () => {
    setTokenProvider(async () => null);
    await http.get('/health');
    expect(send.mock.calls[0][0].headers.Authorization).toBeUndefined();
    await expect(http.get('/api/v1/sessions')).rejects.toThrow('인증');
    expect(send).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).toHaveBeenCalledOnce();
  });

  it('notifies the login boundary on an API authentication failure', async () => {
    send.mockImplementationOnce(async (config) => {
      throw new AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, null, {
        data: {},
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config,
      });
    });
    await expect(http.get('/api/v1/sessions')).rejects.toThrow();
    expect(onAuthFailure).toHaveBeenCalledOnce();
  });

  it('does not expose an authentication provider error', async () => {
    setTokenProvider(async () => {
      throw new Error('private-provider-detail');
    });
    await expect(http.get('/api/v1/sessions')).rejects.toThrow('로그인');
    expect(send).not.toHaveBeenCalled();
    expect(onAuthFailure).toHaveBeenCalledOnce();
  });

  it('does not send a token obtained after the account changed', async () => {
    let resolveToken: (value: string) => void = () => undefined;
    const provider = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );
    setTokenProvider(provider);
    const pending = http.get('/api/v1/sessions').catch((error: unknown) => error);
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    setTokenProvider(async () => 'new-account-token');
    resolveToken('old-account-token');
    expect(await pending).toBeInstanceOf(Error);
    expect(send).not.toHaveBeenCalled();
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('ignores a late unauthorized response from a previous account', async () => {
    let rejectOld: () => void = () => undefined;
    send.mockImplementationOnce(
      (config) =>
        new Promise((_, reject) => {
          rejectOld = () =>
            reject(
              new AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, null, {
                data: {},
                status: 401,
                statusText: 'Unauthorized',
                headers: {},
                config,
              }),
            );
        }),
    );
    const pending = http.get('/api/v1/sessions').catch((error: unknown) => error);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    setTokenProvider(async () => 'new-account-token');
    rejectOld();
    expect(await pending).toBeInstanceOf(Error);
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('does not deliver a successful response from a previous account', async () => {
    let complete: () => void = () => undefined;
    send.mockImplementationOnce(
      (config) =>
        new Promise((resolve) => {
          complete = () =>
            resolve({
              data: { private: 'old-owner-data' },
              status: 200,
              statusText: 'OK',
              headers: {},
              config,
            });
        }),
    );
    const pending = http.get('/api/v1/sessions').catch((error: unknown) => error);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    setTokenProvider(async () => 'new-account-token');
    complete();
    expect(await pending).toBeInstanceOf(Error);
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('does not retry an old operation after the account changes during backoff', async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValueOnce(new AxiosError('offline'));
    const pending = retry(operation).catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(operation).toHaveBeenCalledOnce();
    setTokenProvider(async () => 'new-account-token');
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(Error);
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe('missing session detection', () => {
  function error(status: number, code: string) {
    return new AxiosError('synthetic error', undefined, undefined, null, {
      status,
      statusText: '',
      data: { code },
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    });
  }

  it('only treats an explicit session not-found response as a missing record', () => {
    expect(isMissingSession(error(404, 'not_found'))).toBe(true);
    expect(isMissingSession(error(404, 'policy_not_found'))).toBe(false);
    expect(isMissingSession(error(404, 'http_error'))).toBe(false);
    expect(isMissingSession(error(401, 'not_found'))).toBe(false);
    expect(isMissingSession(new AxiosError('offline'))).toBe(false);
    expect(isMissingSession(new Error('not_found'))).toBe(false);
  });
});
