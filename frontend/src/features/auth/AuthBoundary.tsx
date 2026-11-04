import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setAuthFailureHandler, setTokenProvider } from '../../api/client';
import { Button, Loading, Notice } from '../../components/ui';
import { useMeasurement } from '../../state/measurement';
import { measurement } from '../measurement/controller';
import type { AuthAdapter, AuthStep } from './adapter';
import { AuthContext } from './AuthContext';

type Status = 'checking' | 'signed_out' | 'signed_in';
type Screen = 'login' | 'new_password' | 'code' | 'reset_request' | 'reset_confirm';

export function AuthBoundary({
  adapter,
  children,
}: {
  adapter: AuthAdapter | null;
  children: ReactNode;
}) {
  const cache = useQueryClient();
  const phase = useMeasurement((state) => state.phase);
  const [status, setStatus] = useState<Status>('checking');
  const [screen, setScreen] = useState<Screen>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [response, setResponse] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const owner = useRef<string | null>(null);
  const expired = useRef(false);
  const authFailure = useRef<() => void>(() => undefined);
  const signingOut = useRef(false);

  useEffect(() => {
    if (!['starting', 'active', 'paused', 'recalibrating', 'ending'].includes(phase)) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  useEffect(() => {
    let active = true;
    if (!adapter) {
      setTokenProvider(null);
      setAuthFailureHandler(null);
      return;
    }
    setTokenProvider(() => adapter.getToken());
    authFailure.current = () => {
      if (!active || expired.current) return;
      expired.current = true;
      measurement.reset({ preservePendingStart: true });
      setTokenProvider(null);
      setScreen('login');
      setUsername('');
      setPassword('');
      setResponse('');
      setResetCode('');
      setNotice('');
      setError('로그인이 만료되었습니다. 다시 로그인해 주세요.');
      setStatus('signed_out');
      setBusy(true);
      void cache.cancelQueries();
      cache.clear();
      void adapter
        .signOut()
        .catch(() => undefined)
        .finally(() => {
          if (active) setBusy(false);
        });
    };
    setAuthFailureHandler(adapter.kind === 'cognito' ? authFailure.current : null);
    void (async () => {
      try {
        const signedIn = await adapter.restore();
        const identity = signedIn ? await adapter.getOwnerId() : null;
        if (active) {
          owner.current = identity;
          setStatus(signedIn && identity ? 'signed_in' : 'signed_out');
        }
      } catch {
        if (active) setStatus('signed_out');
      }
    })();
    return () => {
      active = false;
      setTokenProvider(null);
      setAuthFailureHandler(null);
    };
  }, [adapter, cache]);

  async function applyStep(step: AuthStep) {
    if (!adapter) return;
    if (step === 'done') {
      const [token, identity] = await Promise.all([adapter.getToken(), adapter.getOwnerId()]);
      if (!token || !identity) throw new Error('Missing access token or owner');
      const running = ['starting', 'active', 'paused', 'recalibrating', 'ending'].includes(
        useMeasurement.getState().phase,
      );
      if (owner.current && owner.current !== identity && (running || !measurement.reset())) {
        await adapter.signOut();
        setPassword('');
        setResponse('');
        setError('측정을 시작한 같은 계정으로 로그인해 주세요.');
        return;
      }
      owner.current = identity;
      expired.current = false;
      setTokenProvider(() => adapter.getToken());
      setAuthFailureHandler(adapter.kind === 'cognito' ? authFailure.current : null);
      setPassword('');
      setResponse('');
      setError('');
      setStatus('signed_in');
    } else if (step === 'new_password' || step === 'code') {
      setPassword('');
      setResponse('');
      setScreen(step);
    } else if (step === 'reset_password') {
      setPassword('');
      setScreen('reset_request');
    } else {
      setPassword('');
      setError('인증 단계를 완료할 수 없습니다. 관리자에게 문의해 주세요.');
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adapter || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (screen === 'reset_request') {
        const result = await adapter.requestReset(username.trim());
        if (result === 'code') setScreen('reset_confirm');
        else {
          setScreen('login');
          setNotice('비밀번호 변경을 확인해 주세요.');
        }
      } else if (screen === 'reset_confirm') {
        await adapter.confirmReset(username.trim(), resetCode, response);
        setResetCode('');
        setResponse('');
        setScreen('login');
        setNotice('비밀번호가 변경되었습니다.');
      } else {
        const result =
          screen === 'login'
            ? await adapter.signIn(username.trim(), password)
            : await adapter.confirm(response);
        await applyStep(result);
      }
    } catch {
      setPassword('');
      setResponse('');
      setError(
        screen.startsWith('reset')
          ? '비밀번호를 변경하지 못했습니다. 입력 정보를 확인해 주세요.'
          : '로그인을 완료하지 못했습니다. 입력 정보를 확인해 주세요.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!adapter || adapter.kind !== 'cognito' || cache.isMutating() || signingOut.current) return;
    if (
      ['starting', 'active', 'paused', 'recalibrating', 'ending'].includes(
        useMeasurement.getState().phase,
      )
    )
      return;
    if (!measurement.reset()) return;
    signingOut.current = true;
    setAuthFailureHandler(null);
    setTokenProvider(null);
    setBusy(true);
    setStatus('signed_out');
    setScreen('login');
    setUsername('');
    setPassword('');
    setResponse('');
    setResetCode('');
    setError('');
    setNotice('');
    try {
      const cancellation = cache.cancelQueries();
      cache.clear();
      await cancellation;
    } catch {
      cache.clear();
    }
    try {
      await adapter.signOut();
    } catch {
      /* Clear local access even if the network fails. */
    }
    owner.current = null;
    expired.current = false;
    signingOut.current = false;
    setBusy(false);
  }

  if (!adapter)
    return (
      <main className="auth-page">
        <Notice kind="error">서버 설정을 확인해 주세요.</Notice>
      </main>
    );
  if (status === 'checking')
    return (
      <main className="auth-page">
        <Loading />
      </main>
    );
  if (status === 'signed_in') {
    return (
      <AuthContext.Provider value={{ kind: adapter.kind, signOut }}>
        {children}
      </AuthContext.Provider>
    );
  }

  return (
    <main className="auth-page">
      <form className="panel auth-form" onSubmit={(event) => void submit(event)}>
        <h1>로그인</h1>
        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice>{notice}</Notice>}
        {screen === 'login' ? (
          <>
            <label>
              이메일
              <input
                type="email"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label>
              비밀번호
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <Button disabled={busy}>로그인</Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPassword('');
                setError('');
                setNotice('');
                setScreen('reset_request');
              }}
            >
              비밀번호 찾기
            </Button>
          </>
        ) : screen === 'reset_request' ? (
          <>
            <label>
              이메일
              <input
                type="email"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <div className="button-row">
              <Button disabled={busy}>코드 받기</Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setScreen('login');
                  setError('');
                }}
              >
                취소
              </Button>
            </div>
          </>
        ) : screen === 'reset_confirm' ? (
          <>
            <label>
              인증 코드
              <input
                type="text"
                autoComplete="one-time-code"
                value={resetCode}
                onChange={(event) => setResetCode(event.target.value)}
                required
              />
            </label>
            <label>
              새 비밀번호
              <input
                type="password"
                autoComplete="new-password"
                value={response}
                onChange={(event) => setResponse(event.target.value)}
                required
              />
            </label>
            <div className="button-row">
              <Button disabled={busy}>변경</Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setScreen('login');
                  setResponse('');
                  setResetCode('');
                  setError('');
                }}
              >
                취소
              </Button>
            </div>
          </>
        ) : (
          <>
            <label>
              {screen === 'new_password' ? '새 비밀번호' : '인증 코드'}
              <input
                type={screen === 'new_password' ? 'password' : 'text'}
                autoComplete={screen === 'new_password' ? 'new-password' : 'one-time-code'}
                value={response}
                onChange={(event) => setResponse(event.target.value)}
                required
              />
            </label>
            <div className="button-row">
              <Button disabled={busy}>확인</Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setScreen('login');
                  setResponse('');
                  setError('');
                }}
              >
                취소
              </Button>
            </div>
          </>
        )}
      </form>
    </main>
  );
}
