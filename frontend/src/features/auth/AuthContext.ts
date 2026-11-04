import { createContext, useContext } from 'react';

export interface AuthContextValue {
  kind: 'preview' | 'local' | 'cognito';
  signOut(): Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Auth boundary is missing.');
  return value;
}
