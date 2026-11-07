/**
 * Shared runtime state for the Agent Control Tower: the trust-boundary
 * context (`GET /api/act/context`), client-side routing helpers, and the
 * endpoint hook every page uses.
 *
 * Data-source rule (never faked data):
 *  - demo mode    → `/api/act/demo/*` (synthetic dataset, amber banner)
 *  - any other mode → pages render an honest empty state quoting the server's
 *    own `production.reason`; no placeholder rows are invented.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, get } from './api';

export const BASE_PATH = '/agent-control-tower';

export const DEMO_BANNER = 'DEMO ENVIRONMENT — Synthetic data — no real transactions';

/** Shape of GET /api/act/context (docs/ACT-API.md §mode). */
export interface ActContextInfo {
  mode: string;
  banner: string;
  tenant: string;
  seedVersion: string;
  generatedAt: number;
  demo: { enabled: boolean };
  production: { enabled: boolean; entitled: boolean; reason: string };
}

export interface ActEnv {
  ctx: ActContextInfo | null;
  navigate: (to: string) => void;
  /** executive presentation mode: hides sidebar chrome, enlarges type */
  presentation: boolean;
  setPresentation: (value: boolean) => void;
}

export const ActEnvContext = createContext<ActEnv | null>(null);

export function useActEnv(): ActEnv {
  const env = useContext(ActEnvContext);
  if (!env) throw new Error('ControlTower: ActEnvContext provider is missing');
  return env;
}

export function useNavigate(): (to: string) => void {
  return useActEnv().navigate;
}

export function usePresentation(): [boolean, (value: boolean) => void] {
  const env = useActEnv();
  return [env.presentation, env.setPresentation];
}

/* ------------------------------------------------------------------ */
/* context fetch                                                       */
/* ------------------------------------------------------------------ */

export interface ContextState {
  ctx: ActContextInfo | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useActContext(): ContextState {
  const [data, setData] = useState<ActContextInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    get<ActContextInfo>('/context')
      .then((ctx) => {
        if (!cancelled) {
          setData(ctx);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ctx: data, loading, error, reload };
}

/* ------------------------------------------------------------------ */
/* page routing                                                        */
/* ------------------------------------------------------------------ */

export interface Route {
  key: string;
  label: string;
  /** path segments after BASE_PATH, e.g. ['passports','agt_x'] */
  segments: string[];
}

export const PRODUCTION_NAV: Array<{ to: string; label: string }> = [
  { to: BASE_PATH, label: 'Executive Overview' },
  { to: `${BASE_PATH}/registry`, label: 'Agent Registry' },
  { to: `${BASE_PATH}/passports`, label: 'Agent Passports' },
  { to: `${BASE_PATH}/decisions`, label: 'Live Decisions' },
  { to: `${BASE_PATH}/approvals`, label: 'Approvals' },
  { to: `${BASE_PATH}/policies`, label: 'Policy Studio' },
  { to: `${BASE_PATH}/modality`, label: 'Modality Governance' },
  { to: `${BASE_PATH}/appetite`, label: 'Risk Appetite' },
  { to: `${BASE_PATH}/use-cases`, label: 'AI Use Cases' },
  { to: `${BASE_PATH}/performance`, label: 'AI Performance' },
  { to: `${BASE_PATH}/blast-radius`, label: 'Blast Radius' },
  { to: `${BASE_PATH}/incidents`, label: 'Incidents' },
  { to: `${BASE_PATH}/evidence`, label: 'Evidence & Replay' },
  { to: `${BASE_PATH}/frameworks`, label: 'Framework Mapping' },
  { to: `${BASE_PATH}/whatif`, label: 'What-If Simulator' },
  { to: `${BASE_PATH}/integrations`, label: 'Integrations' },
  { to: `${BASE_PATH}/readiness`, label: 'Production Readiness' },
  { to: `${BASE_PATH}/administration`, label: 'Administration' },
];

export const DEMO_NAV: Array<{ to: string; label: string }> = [
  { to: `${BASE_PATH}/demo/executive`, label: 'Executive Demo' },
  { to: `${BASE_PATH}/demo/lab`, label: 'Scenario Lab' },
  { to: `${BASE_PATH}/demo/reset`, label: 'Demo Reset' },
];

const LABEL_BY_SEGMENT: Record<string, string> = {
  '': 'Executive Overview',
  registry: 'Agent Registry',
  passports: 'Agent Passports',
  decisions: 'Live Decisions',
  approvals: 'Approvals',
  policies: 'Policy Studio',
  modality: 'Modality Governance',
  appetite: 'Risk Appetite',
  'use-cases': 'AI Use Cases',
  performance: 'AI Performance',
  'blast-radius': 'Blast Radius',
  incidents: 'Incidents',
  evidence: 'Evidence & Replay',
  frameworks: 'Framework Mapping',
  whatif: 'What-If Simulator',
  integrations: 'Integrations',
  readiness: 'Production Readiness',
  administration: 'Administration',
  demo: 'Executive Demo',
};

/** Map a pathname (any pathname — the shell defaults to the overview) to a route. */
export function resolveRoute(pathname: string): Route {
  const rel = pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) : '';
  const segments = rel.split('/').filter(Boolean);
  const head = segments[0] ?? '';
  if (head === 'demo') {
    const sub = segments[1] ?? 'executive';
    const label = sub === 'lab' ? 'Scenario Lab' : sub === 'reset' ? 'Demo Reset' : 'Executive Demo';
    return { key: `demo-${sub}`, label, segments };
  }
  return { key: head === '' ? 'overview' : head, label: LABEL_BY_SEGMENT[head] ?? 'Agent Control Tower', segments };
}

/** history pushState + popstate only — no router dependency. */
export function navigateTo(to: string): void {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export interface RouteState {
  path: string;
  navigate: (to: string) => void;
}

export function useRoute(): RouteState {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => navigateTo(to), []);
  return { path, navigate };
}

/* ------------------------------------------------------------------ */
/* endpoint hook                                                       */
/* ------------------------------------------------------------------ */

export interface Endpoint<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  /** non-null → the page must render an empty state quoting this reason */
  blocked: string | null;
  reload: () => void;
}

/** Honest reason shown instead of data when no data source is entitled. */
export function unavailableReason(ctx: ActContextInfo): string {
  const parts: string[] = [];
  if (!ctx.demo.enabled) parts.push('demo mode is disabled for this deployment');
  parts.push(ctx.production.reason || 'no data source is configured for this deployment');
  if (ctx.mode === 'production') parts.push('the synthetic demo dataset is not served in production mode');
  return parts.join(' — ');
}

/**
 * Fetch `suffix` from the demo API while demo mode is live; otherwise signal
 * `blocked` so the page can show an honest empty state (never fake rows,
 * never a raw 403 dump).
 */
export function useEndpoint<T>(suffix: string | null): Endpoint<T> {
  const { ctx } = useActEnv();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const demoLive = ctx !== null && ctx.mode === 'demo' && ctx.demo.enabled;
  const path = ctx !== null && demoLive && suffix !== null ? `/demo${suffix}` : null;

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDenied(null);
    get<T>(path)
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        if (err instanceof ApiError && err.status === 403) setDenied(err.message);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const blocked = denied ?? (ctx !== null && !demoLive ? unavailableReason(ctx) : null);
  return { data, loading, error, blocked, reload };
}