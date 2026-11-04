import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthAdapter } from './adapter';

const sdk = vi.hoisted(() => ({
  configure: vi.fn(),
  setStorage: vi.fn(),
  storage: { clear: vi.fn() },
  fetchAuthSession: vi.fn(),
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  signOut: vi.fn(),
  resetPassword: vi.fn(),
  confirmResetPassword: vi.fn(),
}));
vi.mock('aws-amplify', () => ({ Amplify: { configure: sdk.configure } }));
vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: sdk.fetchAuthSession,
  signIn: sdk.signIn,
  confirmSignIn: sdk.confirmSignIn,
  signOut: sdk.signOut,
  resetPassword: sdk.resetPassword,
  confirmResetPassword: sdk.confirmResetPassword,
}));
vi.mock('aws-amplify/auth/cognito', () => ({
  cognitoUserPoolsTokenProvider: { setKeyValueStorage: sdk.setStorage },
}));
vi.mock('aws-amplify/utils', () => ({ sharedInMemoryStorage: sdk.storage }));

const cognito = {
  kind: 'cognito',
  userPoolId: 'ap-northeast-2_Example1',
  clientId: 'exampleclient',
  apiBaseUrl: 'https://api.example.invalid',
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  sdk.fetchAuthSession.mockResolvedValue({
    userSub: 'owner-a',
    tokens: { accessToken: { toString: () => 'access-token' } },
  });
  sdk.signIn.mockResolvedValue({
    nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' },
  });
  sdk.confirmSignIn.mockResolvedValue({ nextStep: { signInStep: 'DONE' } });
  sdk.resetPassword.mockResolvedValue({
    nextStep: { resetPasswordStep: 'CONFIRM_RESET_PASSWORD_WITH_CODE' },
  });
  sdk.confirmResetPassword.mockResolvedValue(undefined);
  sdk.signOut.mockResolvedValue(undefined);
  sdk.storage.clear.mockResolvedValue(undefined);
});

describe('Cognito adapter', () => {
  it('uses memory token storage and the configured SRP login flow', async () => {
    const adapter = (await createAuthAdapter(cognito))!;
    expect(sdk.setStorage).toHaveBeenCalledWith(sdk.storage);
    expect(sdk.configure).toHaveBeenCalledWith({
      Auth: {
        Cognito: {
          userPoolId: cognito.userPoolId,
          userPoolClientId: cognito.clientId,
        },
      },
    });
    expect(await adapter.restore()).toBe(true);
    expect(await adapter.signIn('user@example.invalid', 'temporary-password')).toBe('new_password');
    expect(sdk.signIn).toHaveBeenCalledWith({
      username: 'user@example.invalid',
      password: 'temporary-password',
      options: { authFlowType: 'USER_SRP_AUTH' },
    });
    expect(await adapter.confirm('new-password')).toBe('done');
    expect(await adapter.getToken()).toBe('access-token');
    expect(await adapter.getOwnerId()).toBe('owner-a');
    expect(sdk.fetchAuthSession).toHaveBeenCalledTimes(3);
  });

  it('connects password recovery and clears local tokens even if sign out fails', async () => {
    const adapter = (await createAuthAdapter(cognito))!;
    expect(await adapter.requestReset('user@example.invalid')).toBe('code');
    await adapter.confirmReset('user@example.invalid', '123456', 'new-password');
    expect(sdk.confirmResetPassword).toHaveBeenCalledWith({
      username: 'user@example.invalid',
      confirmationCode: '123456',
      newPassword: 'new-password',
    });
    sdk.signOut.mockRejectedValueOnce(new Error('offline'));
    await expect(adapter.signOut()).rejects.toThrow('offline');
    expect(sdk.storage.clear).toHaveBeenCalledOnce();
  });

  it('keeps loopback development independent of the cloud SDK', async () => {
    const adapter = (await createAuthAdapter({ kind: 'local', token: 'test', apiBaseUrl: '' }))!;
    expect(await adapter.restore()).toBe(true);
    expect(await adapter.getToken()).toBe('test');
    expect(sdk.configure).not.toHaveBeenCalled();
  });

  it('offers camera-only preview without credentials', async () => {
    const adapter = (await createAuthAdapter({ kind: 'preview', apiBaseUrl: '' }))!;
    expect(await adapter.restore()).toBe(true);
    expect(await adapter.getOwnerId()).toBe('preview');
    expect(await adapter.getToken()).toBeNull();
    expect(sdk.configure).not.toHaveBeenCalled();
  });
});
