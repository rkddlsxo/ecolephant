import type { AuthConfig } from './config';

export type AuthStep = 'done' | 'new_password' | 'code' | 'reset_password' | 'unsupported';

export interface AuthAdapter {
  kind: 'preview' | 'local' | 'cognito';
  restore(): Promise<boolean>;
  signIn(username: string, password: string): Promise<AuthStep>;
  confirm(response: string): Promise<AuthStep>;
  getToken(): Promise<string | null>;
  getOwnerId(): Promise<string | null>;
  requestReset(username: string): Promise<'code' | 'done'>;
  confirmReset(username: string, code: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

function authStep(step: string): AuthStep {
  if (step === 'DONE') return 'done';
  if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') return 'new_password';
  if (step === 'RESET_PASSWORD') return 'reset_password';
  if (
    [
      'CONFIRM_SIGN_IN_WITH_TOTP_CODE',
      'CONFIRM_SIGN_IN_WITH_SMS_CODE',
      'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
    ].includes(step)
  )
    return 'code';
  return 'unsupported';
}

export async function createAuthAdapter(config: AuthConfig): Promise<AuthAdapter | null> {
  if (config.kind === 'unavailable') return null;
  if (config.kind === 'local' || config.kind === 'preview') {
    return {
      kind: config.kind,
      restore: async () => true,
      signIn: async () => 'unsupported',
      confirm: async () => 'unsupported',
      getToken: async () => (config.kind === 'local' ? config.token : null),
      getOwnerId: async () => config.kind,
      requestReset: async () => {
        throw new Error('Local authentication has no password');
      },
      confirmReset: async () => {
        throw new Error('Local authentication has no password');
      },
      signOut: async () => undefined,
    };
  }

  const [base, auth, cognito, storage] = await Promise.all([
    import('aws-amplify'),
    import('aws-amplify/auth'),
    import('aws-amplify/auth/cognito'),
    import('aws-amplify/utils'),
  ]);
  cognito.cognitoUserPoolsTokenProvider.setKeyValueStorage(storage.sharedInMemoryStorage);
  base.Amplify.configure({
    Auth: { Cognito: { userPoolId: config.userPoolId, userPoolClientId: config.clientId } },
  });

  return {
    kind: 'cognito',
    restore: async () => Boolean((await auth.fetchAuthSession()).tokens?.accessToken),
    signIn: async (username, password) => {
      const result = await auth.signIn({
        username,
        password,
        options: { authFlowType: 'USER_SRP_AUTH' },
      });
      return authStep(result.nextStep.signInStep);
    },
    confirm: async (response) =>
      authStep((await auth.confirmSignIn({ challengeResponse: response })).nextStep.signInStep),
    getToken: async () => (await auth.fetchAuthSession()).tokens?.accessToken?.toString() ?? null,
    getOwnerId: async () => (await auth.fetchAuthSession()).userSub ?? null,
    requestReset: async (username) => {
      const result = await auth.resetPassword({ username });
      return result.nextStep.resetPasswordStep === 'CONFIRM_RESET_PASSWORD_WITH_CODE'
        ? 'code'
        : 'done';
    },
    confirmReset: async (username, code, password) => {
      await auth.confirmResetPassword({ username, confirmationCode: code, newPassword: password });
    },
    signOut: async () => {
      try {
        await auth.signOut();
      } finally {
        await storage.sharedInMemoryStorage.clear();
      }
    },
  };
}
