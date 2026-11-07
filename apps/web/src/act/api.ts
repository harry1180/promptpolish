/**
 * Agent Control Tower HTTP client.
 *
 * BASE is derived from VITE_API_BASE (empty in dev, the deployment's API
 * prefix in production builds) plus the org API prefix — never a hardcoded
 * path.
 *
 * Every failure throws ApiError carrying the FIRST entry of the server's
 * `{ errors: [...] }` payload so callers can render an honest message instead
 * of a raw status dump. Requests abort after 10s.
 */

export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '') + '/api/act';

const TIMEOUT_MS = 10_000;

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    if (isAbort(err)) throw new ApiError(`Request timed out after ${TIMEOUT_MS / 1000}s`, 0);
    throw new ApiError(err instanceof Error ? err.message : 'network error', 0);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `request failed (status ${res.status})`;
    try {
      const body = (await res.json()) as { errors?: unknown };
      if (Array.isArray(body?.errors) && typeof body.errors[0] === 'string') message = body.errors[0];
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new ApiError(message, res.status);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('response was not valid JSON', res.status);
  }
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}