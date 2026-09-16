import { useCallback, useEffect, useState } from 'react';
import type { AccountInfo, TagMap } from '@promptslim/shared-types';
import { api } from '../api/account';

export interface AccountState {
  account: AccountInfo | null;
  checking: boolean;
  login(email: string, password: string): Promise<string[]>;
  signup(input: { email: string; password: string; name: string; tags: TagMap }): Promise<string[]>;
  logout(): Promise<void>;
  setTags(tags: TagMap): Promise<string[]>;
}

/** Session state for the whole app: restores the HttpOnly-cookie session on
 *  load, and exposes login/signup/logout/tag edits. `authTick` bumps let
 *  consumers (dashboard) refetch after identity changes. */
export function useAccount(): AccountState & { authTick: number } {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [authTick, setAuthTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void api.me().then((r) => {
      if (!alive) return;
      setAccount(r.ok ? (r.data?.account ?? null) : null);
      setChecking(false);
    });
    return () => { alive = false; };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password);
    if (r.ok && r.data) {
      setAccount(r.data.account);
      setAuthTick((t) => t + 1);
      return [];
    }
    return r.errors.length ? r.errors : ['login failed'];
  }, []);

  const signup = useCallback(async (input: { email: string; password: string; name: string; tags: TagMap }) => {
    const r = await api.signup(input);
    if (r.ok && r.data) {
      setAccount(r.data.account);
      setAuthTick((t) => t + 1);
      return [];
    }
    return r.errors.length ? r.errors : ['signup failed'];
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setAccount(null);
    setAuthTick((t) => t + 1);
  }, []);

  const setTags = useCallback(async (tags: TagMap) => {
    const r = await api.setTags(tags);
    if (r.ok && r.data) {
      setAccount(r.data.account);
      setAuthTick((t) => t + 1);
      return [];
    }
    return r.errors.length ? r.errors : ['could not save tags'];
  }, []);

  return { account, checking, login, signup, logout, setTags, authTick };
}
