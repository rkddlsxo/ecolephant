import axios from 'axios';
import type { components } from './generated';

export type Session = components['schemas']['Session'];
export type Sample = components['schemas']['SampleWindow'];
export type SessionEvent = components['schemas']['SessionEvent'];
export type SessionCreate = components['schemas']['SessionCreate'];
export type EventPayload = {
  [K in SessionEvent['type']]: Pick<Extract<SessionEvent, { type: K }>, 'type' | 'data'>;
}[SessionEvent['type']];
export type Metrics = components['schemas']['MetricSummary'];
export type Statistics = components['schemas']['StatisticsResponse'];
export const http = axios.create({
  baseURL: '',
  timeout: 10000,
});
type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider | null = null;
let authFailureHandler: (() => void) | null = null;
let authGeneration = 0;
const requestGenerations = new WeakMap<object, number>();

export function setApiBaseUrl(value: string) {
  http.defaults.baseURL = value;
}

export function setTokenProvider(value: TokenProvider | null) {
  tokenProvider = value;
  authGeneration += 1;
}

export function setAuthFailureHandler(value: (() => void) | null) {
  authFailureHandler = value;
}

http.interceptors.request.use(async (config) => {
  const allowedOrigin = new URL(http.defaults.baseURL || '/', window.location.origin).origin;
  const requestOrigin = new URL(config.url || '/', config.baseURL || window.location.origin).origin;
  if (requestOrigin !== allowedOrigin) throw new Error('서버 주소를 확인해 주세요.');
  if (config.url === '/health') return config;
  const requestGeneration = authGeneration;
  const provider = tokenProvider;
  let token: string | null = null;
  try {
    token = (await provider?.()) ?? null;
  } catch {
    if (requestGeneration === authGeneration) authFailureHandler?.();
    throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.');
  }
  if (requestGeneration !== authGeneration) throw new Error('로그인 상태가 변경되었습니다.');
  if (!token) {
    authFailureHandler?.();
    throw new Error('서버 인증 설정을 확인해 주세요.');
  }
  requestGenerations.set(config, requestGeneration);
  config.headers.Authorization = `Bearer ${token}`;
  return config;
});
http.interceptors.response.use(
  (response) => {
    const generation = requestGenerations.get(response.config);
    if (generation !== undefined && generation !== authGeneration)
      throw new Error('로그인 상태가 변경되었습니다.');
    return response;
  },
  (error: unknown) => {
    if (axios.isAxiosError(error) && error.config) {
      const generation = requestGenerations.get(error.config);
      if (generation !== undefined && generation !== authGeneration)
        return Promise.reject(new Error('로그인 상태가 변경되었습니다.'));
    }
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      error.config?.url !== '/health' &&
      error.config &&
      requestGenerations.get(error.config) === authGeneration
    )
      authFailureHandler?.();
    return Promise.reject(error);
  },
);
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (!error.response) return '서버에 연결되지 않았어요. 연결되면 다시 저장할 수 있습니다.';
    return error.response.data?.message || `요청을 완료하지 못했어요 (${error.response.status}).`;
  }
  return error instanceof Error ? error.message : '처리 중 문제가 발생했어요.';
}
export function isMissingSession(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    error.response?.status === 404 &&
    error.response.data?.code === 'not_found'
  );
}
export async function retry<T>(operation: () => Promise<T>): Promise<T> {
  const generation = authGeneration;
  for (let attempt = 0; ; attempt++) {
    if (generation !== authGeneration) throw new Error('로그인 상태가 변경되었습니다.');
    try {
      return await operation();
    } catch (error) {
      if (generation !== authGeneration) throw new Error('로그인 상태가 변경되었습니다.');
      const retryable =
        axios.isAxiosError(error) &&
        (!error.response ||
          [429, 503].includes(error.response.status) ||
          (error.response.status === 409 && error.response.data?.code === 'concurrent_write'));
      if (!retryable || attempt >= 3) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(8000, 500 * 2 ** attempt) + Math.random() * 300),
      );
    }
  }
}
const sessionUrl = (id: string) => `/api/v1/sessions/${id}`;
export const api = {
  health: () => http.get<components['schemas']['Health']>('/health').then((r) => r.data),
  policies: () =>
    http.get<components['schemas']['PolicyPage']>('/api/v1/policies').then((r) => r.data),
  create: (body: SessionCreate, key: string) =>
    retry(() =>
      http
        .post<Session>('/api/v1/sessions', body, { headers: { 'Idempotency-Key': key } })
        .then((r) => r.data),
    ),
  samples: (id: string, samples: Sample[]) =>
    retry(() =>
      http
        .post<components['schemas']['BatchReceipt']>(`${sessionUrl(id)}/samples:batch`, { samples })
        .then((r) => r.data),
    ),
  events: (id: string, events: SessionEvent[]) =>
    retry(() =>
      http
        .post<components['schemas']['EventReceipt']>(`${sessionUrl(id)}/events:batch`, { events })
        .then((r) => r.data),
    ),
  complete: (id: string, body: components['schemas']['SessionComplete']) =>
    retry(() => http.post<Session>(`${sessionUrl(id)}/complete`, body).then((r) => r.data)),
  sessions: (params: Record<string, string | number | undefined>) =>
    http
      .get<components['schemas']['SessionPage']>('/api/v1/sessions', { params })
      .then((r) => r.data),
  session: (id: string) => http.get<Session>(sessionUrl(id)).then((r) => r.data),
  timeline: (id: string, from = 0, signal?: AbortSignal) =>
    http
      .get<components['schemas']['Timeline']>(`${sessionUrl(id)}/timeline`, {
        params: {
          from_elapsed_ms: from,
          to_elapsed_ms: Math.min(from + 6 * 60 * 60 * 1000, Number.MAX_SAFE_INTEGER),
        },
        signal,
      })
      .then((r) => r.data),
  eventList: (id: string, cursor?: string, signal?: AbortSignal) =>
    http
      .get<components['schemas']['EventPage']>(`${sessionUrl(id)}/events`, {
        params: { limit: 100, cursor },
        signal,
      })
      .then((r) => r.data),
  remove: (id: string) => http.delete(sessionUrl(id)),
  statistics: (params: Record<string, string>) =>
    http.get<Statistics>('/api/v1/statistics', { params }).then((r) => r.data),
};
