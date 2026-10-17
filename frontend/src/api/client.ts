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
let token = import.meta.env.DEV ? (import.meta.env.VITE_LOCAL_TOKEN ?? '') : '';
export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '',
  timeout: 10000,
});
http.interceptors.request.use((config) => {
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
export function setAccessToken(value: string) {
  token = value;
}
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (!error.response) return '서버에 연결되지 않았어요. 연결되면 다시 저장할 수 있습니다.';
    return error.response.data?.message || `요청을 완료하지 못했어요 (${error.response.status}).`;
  }
  return error instanceof Error ? error.message : '처리 중 문제가 발생했어요.';
}
export async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
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
  timeline: (id: string) =>
    http.get<components['schemas']['Timeline']>(`${sessionUrl(id)}/timeline`).then((r) => r.data),
  eventList: (id: string, cursor?: string) =>
    http
      .get<components['schemas']['EventPage']>(`${sessionUrl(id)}/events`, {
        params: { limit: 100, cursor },
      })
      .then((r) => r.data),
  remove: (id: string) => http.delete(sessionUrl(id)),
  statistics: (params: Record<string, string>) =>
    http.get<Statistics>('/api/v1/statistics', { params }).then((r) => r.data),
};
