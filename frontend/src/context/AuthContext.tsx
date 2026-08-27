import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { api, getAccessToken } from '../lib/api';

interface AuthContextValue {
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => Boolean(getAccessToken()));

  const login = useCallback(async (username: string, password: string) => {
    await api.login(username, password);
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    api.logout();
    setIsAuthenticated(false);
  }, []);

  return <AuthContext.Provider value={{ isAuthenticated, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return ctx;
}
