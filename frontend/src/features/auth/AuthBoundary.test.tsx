import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthBoundary } from './AuthBoundary';
import { useAuth } from './AuthContext';
import type { AuthAdapter } from './adapter';
import type { Session } from '../../api/client';
import { initialMeasurement, useMeasurement } from '../../state/measurement';
import { measurement } from '../measurement/controller';

const clientMock = vi.hoisted(() => ({
  setTokenProvider: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  api: { create: vi.fn(), samples: vi.fn(), events: vi.fn(), complete: vi.fn() },
  errorMessage: (error: Error) => error.message,
  isMissingSession: () => false,
}));
vi.mock('../../api/client', () => clientMock);

function ProtectedApp() {
  const { signOut } = useAuth();
  return (
    <>
      <div>보호된 기록</div>
      <button onClick={() => void signOut()}>로그아웃</button>
    </>
  );
}
function setup(overrides: Partial<AuthAdapter> = {}) {
  const adapter: AuthAdapter = {
    kind: 'cognito',
    restore: vi.fn().mockResolvedValue(false),
    signIn: vi.fn().mockResolvedValue('done'),
    confirm: vi.fn().mockResolvedValue('done'),
    getToken: vi.fn().mockResolvedValue('ephemeral-test-token'),
    getOwnerId: vi.fn().mockResolvedValue('owner-a'),
    requestReset: vi.fn().mockResolvedValue('code'),
    confirmReset: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cache}>
      <AuthBoundary adapter={adapter}>
        <ProtectedApp />
      </AuthBoundary>
    </QueryClientProvider>,
  );
  return { adapter, cache };
}

afterEach(() => {
  cleanup();
  useMeasurement.setState(initialMeasurement, true);
  measurement.reset();
  vi.clearAllMocks();
});

describe('authentication boundary', () => {
  it('blocks private screens until sign in succeeds and clears cached data on sign out', async () => {
    const { adapter, cache } = setup();
    expect(await screen.findByRole('button', { name: '로그인' })).toBeEnabled();
    expect(screen.queryByText('보호된 기록')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('이메일'), {
      target: { value: 'user@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText('보호된 기록')).toBeInTheDocument();
    expect(adapter.signIn).toHaveBeenCalledWith('user@example.invalid', 'test-password');
    cache.setQueryData(['private-history'], { owner: 'user-a' });
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    await screen.findByRole('button', { name: '로그인' });
    expect(adapter.signOut).toHaveBeenCalledOnce();
    expect(cache.getQueryData(['private-history'])).toBeUndefined();
  });

  it('clears completed measurement state immediately when signing out', async () => {
    let finish: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    setup({ restore: vi.fn().mockResolvedValue(true), signOut: vi.fn().mockReturnValue(pending) });
    await screen.findByText('보호된 기록');
    useMeasurement.setState({
      phase: 'completed',
      session: { id: 'previous-private-session' } as Session,
      elapsedMs: 12000,
      saved: 5,
    });
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    await screen.findByRole('button', { name: '로그인' });
    expect(useMeasurement.getState().session).toBeNull();
    expect(useMeasurement.getState().phase).toBe('idle');
    expect(useMeasurement.getState().elapsedMs).toBe(0);
    expect(useMeasurement.getState().saved).toBe(0);
    await act(async () => finish());
  });

  it('clears completed measurements when authentication expires', async () => {
    const { adapter } = setup({ restore: vi.fn().mockResolvedValue(true) });
    await screen.findByText('보호된 기록');
    useMeasurement.setState({
      phase: 'completed',
      session: { id: 'private-session' } as Session,
      elapsedMs: 3000,
    });
    const onFailure = clientMock.setAuthFailureHandler.mock.calls.at(-1)?.[0] as () => void;
    act(() => onFailure());
    await screen.findByRole('button', { name: '로그인' });
    await waitFor(() => expect(adapter.signOut).toHaveBeenCalled());
    expect(useMeasurement.getState().session).toBeNull();
    expect(useMeasurement.getState().elapsedMs).toBe(0);
  });

  it('clears a finished session if a different account signs in after expiry', async () => {
    const getOwnerId = vi.fn().mockResolvedValueOnce('owner-a').mockResolvedValueOnce('owner-b');
    const { adapter } = setup({ restore: vi.fn().mockResolvedValue(true), getOwnerId });
    await screen.findByText('보호된 기록');
    useMeasurement.setState({ phase: 'active' });
    const onFailure = clientMock.setAuthFailureHandler.mock.calls.at(-1)?.[0] as () => void;
    act(() => onFailure());
    await screen.findByRole('button', { name: '로그인' });
    await waitFor(() => expect(adapter.signOut).toHaveBeenCalled());
    useMeasurement.setState({ phase: 'completed', session: { id: 'private-session' } as Session });
    fireEvent.change(screen.getByLabelText('이메일'), {
      target: { value: 'other@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    await screen.findByText('보호된 기록');
    expect(useMeasurement.getState().session).toBeNull();
    expect(useMeasurement.getState().phase).toBe('idle');
  });

  it.each([
    { label: 'different', nextOwner: 'owner-b', reuse: false },
    { label: 'same', nextOwner: 'owner-a', reuse: true },
  ])('handles a failed start after a $label-account login', async ({ nextOwner, reuse }) => {
    const getOwnerId = vi.fn().mockResolvedValueOnce('owner-a').mockResolvedValueOnce(nextOwner);
    const { adapter } = setup({ restore: vi.fn().mockResolvedValue(true), getOwnerId });
    await screen.findByText('보호된 기록');
    let failStart: (error: Error) => void = () => undefined;
    const pendingStart = new Promise<Session>((_resolve, reject) => {
      failStart = reject;
    });
    clientMock.api.create.mockReturnValueOnce(pendingStart);
    const start = measurement.start('webcam');
    const [firstBody, firstKey] = clientMock.api.create.mock.calls[0];
    const onFailure = clientMock.setAuthFailureHandler.mock.calls.at(-1)?.[0] as () => void;
    act(() => onFailure());
    act(() => failStart(new Error('authentication expired')));
    await expect(start).rejects.toThrow('authentication expired');
    await screen.findByRole('button', { name: '로그인' });
    await waitFor(() => expect(adapter.signOut).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('이메일'), {
      target: { value: 'other@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    await screen.findByText('보호된 기록');
    clientMock.api.create.mockImplementationOnce(async (body) => ({
      id: 'new-session',
      started_at: body.started_at,
    }));
    await act(async () => {
      await measurement.start('webcam');
    });
    const [secondBody, secondKey] = clientMock.api.create.mock.calls[1];
    expect(secondBody.client_session_id === firstBody.client_session_id).toBe(reuse);
    expect(secondKey === firstKey).toBe(reuse);
  });

  it('handles the first-login password challenge without exposing server errors', async () => {
    const adapterSignIn = vi
      .fn()
      .mockResolvedValueOnce('new_password')
      .mockRejectedValueOnce(new Error('private-provider-detail'));
    const { adapter } = setup({ signIn: adapterSignIn });
    await screen.findByRole('button', { name: '로그인' });
    fireEvent.change(screen.getByLabelText('이메일'), {
      target: { value: 'user@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), {
      target: { value: 'temporary-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    fireEvent.change(await screen.findByLabelText('새 비밀번호'), {
      target: { value: 'new-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    await screen.findByText('보호된 기록');
    expect(adapter.confirm).toHaveBeenCalledWith('new-password');
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    await screen.findByRole('button', { name: '로그인' });
    fireEvent.change(screen.getByLabelText('이메일'), {
      target: { value: 'user@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).not.toHaveTextContent('private-provider-detail');
  });

  it('does not open private content when a saved session is invalid', async () => {
    setup({ restore: vi.fn().mockRejectedValue(new Error('expired-private-token')) });
    expect(await screen.findByRole('button', { name: '로그인' })).toBeEnabled();
    expect(screen.queryByText('보호된 기록')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('expired-private-token');
  });

  it('preserves an active measurement and requires the same account after expiry', async () => {
    const getOwnerId = vi
      .fn()
      .mockResolvedValueOnce('owner-a')
      .mockResolvedValueOnce('owner-b')
      .mockResolvedValueOnce('owner-a');
    const { adapter, cache } = setup({ restore: vi.fn().mockResolvedValue(true), getOwnerId });
    await screen.findByText('보호된 기록');
    cache.setQueryData(['private-history'], { owner: 'owner-a' });
    useMeasurement.setState({ phase: 'active' });
    const onFailure = clientMock.setAuthFailureHandler.mock.calls.at(-1)?.[0] as () => void;
    expect(onFailure).toBeTypeOf('function');
    act(() => onFailure());
    await screen.findByRole('button', { name: '로그인' });
    await waitFor(() => expect(adapter.signOut).toHaveBeenCalled());
    expect(cache.getQueryData(['private-history'])).toBeUndefined();
    expect(useMeasurement.getState().phase).toBe('active');
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    fireEvent.change(screen.getByLabelText('이메일'), {
      target: { value: 'different@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('같은 계정');
    expect(screen.queryByText('보호된 기록')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('이메일'), {
      target: { value: 'original@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText('보호된 기록')).toBeInTheDocument();
    expect(useMeasurement.getState().phase).toBe('active');
  });

  it('does not allow sign out while a session is being saved', async () => {
    const { adapter } = setup({ restore: vi.fn().mockResolvedValue(true) });
    await screen.findByText('보호된 기록');
    useMeasurement.setState({ phase: 'ending' });
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(adapter.signOut).not.toHaveBeenCalled();
    expect(screen.getByText('보호된 기록')).toBeInTheDocument();
  });

  it('protects an unresolved missing session from sign out and accidental page exit', async () => {
    const { adapter } = setup({ restore: vi.fn().mockResolvedValue(true) });
    await screen.findByText('보호된 기록');
    act(() => useMeasurement.setState({ phase: 'ending', missingSession: true, pending: 2 }));
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(adapter.signOut).not.toHaveBeenCalled();
    expect(useMeasurement.getState().pending).toBe(2);
  });

  it('immediately hides private data while sign out is still pending', async () => {
    let finish: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    setup({ restore: vi.fn().mockResolvedValue(true), signOut: vi.fn().mockReturnValue(pending) });
    await screen.findByText('보호된 기록');
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    const login = await screen.findByRole('button', { name: '로그인' });
    expect(screen.queryByText('보호된 기록')).not.toBeInTheDocument();
    expect(login).toBeDisabled();
    await act(async () => finish());
    expect(login).toBeEnabled();
  });

  it('clears the email and private cache before slow logout cleanup finishes', async () => {
    const { cache } = setup();
    await screen.findByRole('button', { name: '로그인' });
    fireEvent.change(screen.getByLabelText('이메일'), {
      target: { value: 'first@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    await screen.findByText('보호된 기록');
    cache.setQueryData(['private-history'], { owner: 'owner-a' });
    let finish: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(cache, 'cancelQueries').mockReturnValueOnce(pending);
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    await screen.findByRole('button', { name: '로그인' });
    expect(screen.getByLabelText('이메일')).toHaveValue('');
    expect(cache.getQueryData(['private-history'])).toBeUndefined();
    await act(async () => finish());
  });

  it('does not show the previous email after an authentication expiry', async () => {
    const { adapter } = setup();
    await screen.findByRole('button', { name: '로그인' });
    fireEvent.change(screen.getByLabelText('이메일'), {
      target: { value: 'first@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    await screen.findByText('보호된 기록');
    const onFailure = clientMock.setAuthFailureHandler.mock.calls.at(-1)?.[0] as () => void;
    act(() => onFailure());
    await screen.findByRole('button', { name: '로그인' });
    await waitFor(() => expect(adapter.signOut).toHaveBeenCalled());
    expect(screen.getByLabelText('이메일')).toHaveValue('');
  });

  it('recovers a password through a verification code', async () => {
    const { adapter } = setup();
    await screen.findByRole('button', { name: '로그인' });
    fireEvent.change(screen.getByLabelText('이메일'), {
      target: { value: 'user@example.invalid' },
    });
    fireEvent.click(screen.getByRole('button', { name: '비밀번호 찾기' }));
    fireEvent.click(screen.getByRole('button', { name: '코드 받기' }));
    fireEvent.change(await screen.findByLabelText('인증 코드'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('새 비밀번호'), { target: { value: 'new-password' } });
    fireEvent.click(screen.getByRole('button', { name: '변경' }));
    expect(await screen.findByRole('button', { name: '로그인' })).toBeEnabled();
    expect(adapter.requestReset).toHaveBeenCalledWith('user@example.invalid');
    expect(adapter.confirmReset).toHaveBeenCalledWith(
      'user@example.invalid',
      '123456',
      'new-password',
    );
  });
});
