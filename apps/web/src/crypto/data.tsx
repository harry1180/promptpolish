/**
 * Crypto shell state: constants, path routing (pushState/popstate only — no
 * router dependency) and the polling endpoint hook every page uses.
 *
 * Refresh contract: /status every 30s, data endpoints every 60s — both only
 * while `document.visibilityState === 'visible'`, cleared on hidden/unmount.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from './api';

export const BASE_PATH = '/crypto';

/** Always-visible paper-trading badge text. */
export const PAPER_BANNER = 'PAPER TRADING · NO REAL MONEY IS BEING USED';
/** Always-visible 24/7 badge — crypto never closes. */
export const ALWAYS_OPEN = '24/7 · CRYPTO MARKET NEVER CLOSES';

export const REFRESH_MS = 60_000;
export const STATUS_REFRESH_MS = 30_000;

export interface NavItem {
  key: string;
  to: string;
  label: string;
}

export const NAV: NavItem[] = [
  { key: 'overview', to: `${BASE_PATH}/overview`, label: 'Overview' },
  { key: 'market', to: `${BASE_PATH}/market`, label: 'Market' },
  { key: 'signals', to: `${BASE_PATH}/signals`, label: 'Signals' },
  { key: 'paper-trading', to: `${BASE_PATH}/paper-trading`, label: 'Paper Trading' },
  { key: 'learning', to: `${BASE_PATH}/learning`, label: 'Learning' },
  { key: 'system', to: `${BASE_PATH}/system`, label: 'System' },
];

export interface Route {
  key: string;
  label: string;
  /** segments after BASE_PATH, e.g. ['signals','sig_42'] */
  segments: string[];
}

/** Map ANY pathname to a route — the shell falls back to the Overview page. */
export function resolveRoute(pathname: string): Route {
  const rel = pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) : '';
  const segments = rel.split('/').filter(Boolean);
  const head = segments[0] ?? '';
  const item = NAV.find((n) => n.key === head);
  if (item) return { key: item.key, label: item.label, segments };
  if (head === '') return { key: 'overview', label: 'Overview', segments: ['overview'] };
  return { key: head, label: head, segments };
}

export function navigateTo(to: string): void {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function Link({
  to,
  children,
  className,
  title,
  ariaLabel,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <a
      href={to}
      title={title}
      aria-label={ariaLabel}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        navigateTo(to);
      }}
    >
      {children}
    </a>
  );
}

export interface RouteState {
  path: string;
  navigate: (to: string) => void;
}

export function useRoute(): RouteState {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => navigateTo(to), []);
  return { path, navigate };
}

/* ------------------------------------------------------------------ */
/* polling endpoint hook                                               */
/* ------------------------------------------------------------------ */

export interface Endpoint<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Fetch `path` through `loader`, then re-poll every `refreshMs` while the
 * document is visible. The interval is cleared on unmount; hidden documents
 * skip the tick entirely so background tabs never hammer the API.
 *
 * `path` is the effect key: pass a stable string (include query params) and
 * the data refetches whenever it changes.
 */
export function useEndpoint<T>(path: string | null, loader: () => Promise<T>, refreshMs: number = REFRESH_MS): Endpoint<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const run = (): void => {
      loaderRef
        .current()
        .then((value) => {
          if (cancelled) return;
          setData(value);
          setError(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setLoading(false);
          setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
        });
    };

    run();
    const timer = setInterval(() => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') run();
    }, refreshMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, nonce, refreshMs]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}
