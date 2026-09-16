import type {
  AccountInfo, AggregateRequest, AggregateResponse, ChatRequest, ChatResponse,
  ProviderKeyInfo, TagMap,
} from '@promptslim/shared-types';

/** Thin typed client for the org server (apps/server). Same-origin /api —
 *  vite proxies it to :8787 in dev. All calls send HttpOnly cookies, no tokens
 *  in JS (nothing to leak from a compromised render path). */

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  errors: string[];
}

async function call<T>(path: string, method: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* empty body */
    }
    const d = (data ?? {}) as { errors?: string[] };
    return {
      ok: res.ok,
      status: res.status,
      data: (data ?? undefined) as T | undefined,
      errors: Array.isArray(d.errors) ? d.errors : [],
    };
  } catch {
    return { ok: false, status: 0, errors: ['server unreachable — is apps/server running? (pnpm server)'] };
  }
}

export interface AccountResponse {
  account: AccountInfo;
}

export const api = {
  signup: (input: { email: string; password: string; name: string; tags: TagMap }) =>
    call<AccountResponse>('/api/signup', 'POST', input),
  login: (email: string, password: string) =>
    call<AccountResponse>('/api/login', 'POST', { email, password }),
  logout: () => call<{ ok: boolean }>('/api/logout', 'POST'),
  me: () => call<AccountResponse>('/api/me', 'GET'),
  setTags: (tags: TagMap) => call<AccountResponse>('/api/me/tags', 'PUT', { tags }),
  recordEvent: (input: {
    modelId: string;
    level: string;
    originalTokens: number;
    optimizedTokens: number;
    fromCache: boolean;
  }) => call<{ ok: boolean }>('/api/events', 'POST', input),
  aggregate: (req: AggregateRequest) => call<AggregateResponse>('/api/aggregate', 'POST', req),
  facets: () =>
    call<{ facets: Array<{ key: string; values: Array<{ value: string; events: number }> }> }>(
      '/api/tags/facets', 'GET',
    ),
  chat: (req: ChatRequest) => call<ChatResponse>('/api/chat', 'POST', req),
  keys: () => call<{ keys: ProviderKeyInfo[] }>('/api/keys', 'GET'),
  saveKey: (provider: string, apiKey: string) =>
    call<{ keys: ProviderKeyInfo[] }>('/api/keys', 'PUT', { provider, apiKey }),
  deleteKey: (provider: string) =>
    call<{ keys: ProviderKeyInfo[] }>(`/api/keys?provider=${encodeURIComponent(provider)}`, 'DELETE'),
};
