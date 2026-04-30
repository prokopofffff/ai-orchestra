import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import { AuthError } from "../api";
import type { User } from "@ai-orchestra/shared";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    api.fetchMe()
      .then((u) => { if (!cancelled) setUser(u); })
      .catch(() => { if (!cancelled) setUser(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Any query that hits a 401 throws AuthError; clearing the user makes
  // <RequireAuth> redirect to /login on the next render. Also drop the
  // cached query data so we don't briefly show stale data after re-login.
  useEffect(() => {
    const queryCache = queryClient.getQueryCache();
    const mutationCache = queryClient.getMutationCache();

    function handle(err: unknown) {
      if (err instanceof AuthError) {
        setUser(null);
        queryClient.clear();
      }
    }

    const unsubQ = queryCache.subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        handle(event.action.error);
      }
    });
    const unsubM = mutationCache.subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        handle(event.action.error);
      }
    });

    return () => { unsubQ(); unsubM(); };
  }, [queryClient]);

  const login = useCallback(async (email: string, password: string) => {
    const u = await api.login({ email, password });
    setUser(u);
  }, []);

  const signup = useCallback(async (email: string, username: string, password: string) => {
    const u = await api.signup({ email, username, password });
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
