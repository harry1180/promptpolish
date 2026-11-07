/**
 * HTTP surface for the multi-exchange layer — mounted from `handleCrypto`
 * under `/api/crypto/{providers,xchange,context}` (edge: `/pp/api/crypto/*`).
 *
 * Read-only, no auth changes, no secrets: provider status enums and numbers
 * only. The layer is data-only, so nothing here can move a position.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CryptoRuntime } from '../crypto/runtime.ts';
import { evaluateSourceContribution } from './evaluation.ts';

export interface XchangeDeps {
  runtime: CryptoRuntime;
  json: (res: ServerResponse, status: number, body: unknown) => void;
}

type Res = { status: number; body: unknown };

const SYMBOL_RE = /^[A-Z0-9]{2,10}$/;

export async function handleXchange(
  req: IncomingMessage,
  _res: ServerResponse,
  rest: string[],
  deps: XchangeDeps,
): Promise<boolean> {
  const { runtime, json } = deps;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const done = (r: Res): true => { json(_res, r.status, r.body); return true; };
  const now = Date.now();

  const symbol = (url.searchParams.get('symbol') ?? 'BTC').toUpperCase();
  const sym = SYMBOL_RE.test(symbol) ? symbol : 'BTC';
  const windowMs = (() => {
    const w = Number(url.searchParams.get('window'));
    return Number.isFinite(w) && w >= 60_000 && w <= 7 * 86_400_000 ? w : 3_600_000;
  })();

  try {
    /* ---------------- provider registry ---------------- */
    if (rest[0] === 'providers' && req.method === 'GET') {
      return done({ status: 200, body: runtime.xchange.status() });
    }

    /* ---------------- cross-exchange features ---------------- */
    if (rest[0] === 'xchange' && rest.length === 1 && req.method === 'GET') {
      const cfg = runtime.config.xchange;
      if (!cfg.enabled) {
        return done({
          status: 200,
          body: { ok: true, enabled: false, symbol: sym, note: 'CRYPTO_XCHANGE_ENABLED=0' },
        });
      }
      const features = runtime.xchange.features(sym, windowMs);
      const samples = runtime.xchange.samples(windowMs, sym);
      return done({
        status: 200,
        body: {
          ok: true,
          enabled: true,
          symbol: sym,
          windowMs,
          generatedAt: now,
          monitors: cfg.symbols,
          quote: cfg.quote,
          sampleCount: samples.length,
          features,
          note: features
            ? 'research-only: none of these values feeds a trading decision'
            : 'no synchronized samples yet — the layer is collecting',
        },
      });
    }

    /* ---------------- raw sample history (bounded) ---------------- */
    if (rest[0] === 'xchange' && rest[1] === 'history' && req.method === 'GET') {
      const minutes = (() => {
        const m = Number(url.searchParams.get('minutes'));
        return Number.isFinite(m) && m > 0 && m <= 60 * 24 ? Math.floor(m) : 30;
      })();
      const rows = runtime.xchange.samples(minutes * 60_000, sym);
      const capped = rows.slice(-1500);
      return done({
        status: 200,
        body: {
          ok: true,
          symbol: sym,
          minutes,
          count: capped.length,
          total: rows.length,
          truncated: rows.length > capped.length,
          rows: capped.map((r) => ({
            ts: r.ts, provider: r.provider, quote: r.quote, mid: r.mid,
            spreadBps: r.spreadBps, events: r.events, valid: r.valid,
          })),
        },
      });
    }

    /* ---------------- source-level accuracy contribution ---------------- */
    if (rest[0] === 'sources' && req.method === 'GET') {
      const body = evaluateSourceContribution(runtime.db, {
        symbol: sym,
        feePct: runtime.config.feePct,
        now,
      });
      return done({ status: 200, body: { ok: true, ...body } });
    }

    /* ---------------- REST context sources ---------------- */
    if (rest[0] === 'context' && req.method === 'GET') {
      const cfg = runtime.config.xchange;
      if (!cfg.contextEnabled) {
        return done({
          status: 200,
          body: { ok: true, enabled: false, sources: [], data: {}, note: 'CRYPTO_XCHANGE_CONTEXT is off' },
        });
      }
      return done({
        status: 200,
        body: {
          ok: true,
          enabled: true,
          generatedAt: now,
          sources: runtime.xchange.contextSnapshots(),
          cacheEntries: runtime.xchange.contextCounts(),
          data: runtime.xchange.contextData(),
          note: 'lower-frequency research context — never mixed into realtime features',
        },
      });
    }

    return done({ status: 404, body: { error: 'unknown xchange endpoint' } });
  } catch (err) {
    return done({ status: 500, body: { error: err instanceof Error ? err.message : 'xchange route failed' } });
  }
}