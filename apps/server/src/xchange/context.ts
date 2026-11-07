/**
 * Free REST context sources — DEX Screener, GeckoTerminal, CoinGecko Demo.
 *
 * These are LOWER-FREQUENCY research inputs (default 5-minute poll), cached
 * in `xchange_context` with a TTL. They never feed the scalping model and
 * never appear as REALTIME: delayed REST context is labeled as context.
 *
 * Rate limiting: a per-source minimum interval + retry/backoff on 429 with a
 * request budget per poll window. CoinGecko works keyless today; if a
 * COINGECKO_DEMO_KEY is configured it is sent as `x-cg-demo-api-key`. A 401
 * means the keyless path was withdrawn -> NEEDS_CONFIGURATION (never claimed
 * operational).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ContextSourceSnapshot, ProviderState } from './types.ts';

export interface ContextAdapter {
  readonly id: string;
  readonly label: string;
  fetchOnce(): Promise<unknown | null>;
  status(): ContextSourceSnapshot;
}

export interface ContextOptions {
  db: DatabaseSync;
  pollMs: number;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: () => number;
}

interface SourceSpec {
  id: string;
  label: string;
  url: () => string;
  headers: Record<string, string>;
  /** max requests allowed per poll window */
  budget: number;
  /** minimum spacing between requests to this source, ms */
  minIntervalMs: number;
  ttlMs: number;
  trim?: (payload: unknown) => unknown;
}

function trimDexScreener(payload: unknown): unknown {
  const pairs = (payload as { pairs?: unknown[] })?.pairs ?? [];
  return {
    pairs: (pairs as Array<Record<string, unknown>>).slice(0, 12).map((p) => ({
      chainId: p.chainId,
      dexId: p.dexId,
      pairAddress: p.pairAddress,
      base: (p.baseToken as { symbol?: string } | undefined)?.symbol ?? null,
      quote: (p.quoteToken as { symbol?: string } | undefined)?.symbol ?? null,
      priceUsd: p.priceUsd ?? null,
      liquidityUsd: (p.liquidity as { usd?: number } | undefined)?.usd ?? null,
      volume24h: (p.volume as { h24?: number } | undefined)?.h24 ?? null,
      priceChange24h: (p.priceChange as { h24?: number } | undefined)?.h24 ?? null,
      poolCreatedAt: p.pairCreatedAt ?? null,
    })),
  };
}

function trimGecko(payload: unknown): unknown {
  const data = (payload as { data?: unknown[] })?.data ?? [];
  return {
    pools: (data as Array<Record<string, unknown>>).slice(0, 12).map((p) => {
      const a = (p.attributes ?? {}) as Record<string, unknown>;
      return {
        id: p.id ?? null,
        name: a.name ?? null,
        basePriceUsd: a.base_token_price_usd ?? null,
        quotePriceUsd: a.quote_token_price_usd ?? null,
        reserveUsd: a.reserve_in_usd ?? null,
        volume24h: (a.volume_usd as { h24?: string } | undefined)?.h24 ?? null,
        priceChange24h: (a.price_change_percentage as { h24?: string } | undefined)?.h24 ?? null,
      };
    }),
  };
}

function trimCoinGecko(payload: unknown): unknown {
  const rows = Array.isArray(payload) ? payload : [];
  return {
    markets: rows.slice(0, 25).map((r: Record<string, unknown>) => ({
      id: r.id,
      symbol: r.symbol,
      rank: r.market_cap_rank,
      priceUsd: r.current_price,
      marketCap: r.market_cap,
      volume24h: r.total_volume,
      change24hPct: r.price_change_percentage_24h,
    })),
  };
}

const SPECS: Record<string, SourceSpec> = {
  dexscreener: {
    id: 'dexscreener',
    label: 'DEX Screener',
    // WETH pairs across DEXs: liquidity + volume + 24h change for the ETH market
    url: () => 'https://api.dexscreener.com/latest/dex/tokens/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    headers: { 'user-agent': 'hermes-xchange/1.0 (+research)' },
    budget: 30,
    minIntervalMs: 60_000,
    ttlMs: 15 * 60_000,
    trim: trimDexScreener,
  },
  geckoterminal: {
    id: 'geckoterminal',
    label: 'GeckoTerminal',
    url: () => 'https://api.geckoterminal.com/api/v2/networks/eth/trending_pools?page=1',
    headers: { accept: 'application/json', 'user-agent': 'hermes-xchange/1.0 (+research)' },
    budget: 30,
    minIntervalMs: 60_000,
    ttlMs: 15 * 60_000,
    trim: trimGecko,
  },
  coingecko: {
    id: 'coingecko',
    label: 'CoinGecko',
    url: () => 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&price_change_percentage=24h',
    headers: { 'user-agent': 'hermes-xchange/1.0 (+research)' },
    budget: 20,
    minIntervalMs: 60_000,
    ttlMs: 15 * 60_000,
    trim: trimCoinGecko,
  },
};

class RestSource implements ContextAdapter {
  readonly id: string;
  readonly label: string;
  private readonly spec: SourceSpec;
  private readonly opts: ContextOptions;
  private requests = 0;
  private windowStart = 0;
  private lastFetchTs: number | null = null;
  private lastFetchOkTs: number | null = null;
  private lastError: string | null = null;
  private state: ProviderState = 'CONFIGURED';
  private note: string | null = 'not polled yet';
  private cacheEntries = 0;
  private failures = 0;
  private nextAllowed = 0;

  constructor(spec: SourceSpec, opts: ContextOptions) {
    this.spec = spec;
    this.opts = opts;
    this.id = spec.id;
    this.label = spec.label;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async fetchOnce(): Promise<unknown | null> {
    const now = this.now();
    if (now < this.nextAllowed) return null;
    if (now - this.windowStart > 3_600_000) {
      this.windowStart = now;
      this.requests = 0;
    }
    if (this.requests >= this.spec.budget) {
      this.state = 'DEGRADED';
      this.note = `request budget exhausted (${this.requests}/${this.spec.budget} this hour)`;
      return null;
    }
    this.requests += 1;
    this.lastFetchTs = now;
    const headers: Record<string, string> = { ...this.spec.headers };
    if (this.id === 'coingecko' && this.opts.apiKey) headers['x-cg-demo-api-key'] = this.opts.apiKey;
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      const res = await doFetch(this.spec.url(), { headers });
      if (res.status === 401 || res.status === 403) {
        this.failures += 1;
        this.lastError = `HTTP ${res.status}`;
        this.state = this.id === 'coingecko' && !this.opts.apiKey ? 'NEEDS_CONFIGURATION' : 'UNAVAILABLE';
        this.note = this.id === 'coingecko' && !this.opts.apiKey
          ? 'keyless access withdrawn — set COINGECKO_DEMO_KEY'
          : `rejected with HTTP ${res.status}`;
        this.nextAllowed = now + this.spec.minIntervalMs;
        return null;
      }
      if (res.status === 429) {
        this.failures += 1;
        this.lastError = 'HTTP 429 rate limited';
        this.state = 'DEGRADED';
        this.note = 'rate limited — backing off';
        this.nextAllowed = now + Math.min(600_000, this.spec.minIntervalMs * 2 ** Math.min(this.failures, 5));
        return null;
      }
      if (!res.ok) {
        this.failures += 1;
        this.lastError = `HTTP ${res.status}`;
        this.state = 'DEGRADED';
        this.note = `HTTP ${res.status}`;
        this.nextAllowed = now + this.spec.minIntervalMs;
        return null;
      }
      const raw: unknown = await res.json();
      const payload = this.spec.trim ? this.spec.trim(raw) : raw;
      this.failures = 0;
      this.lastError = null;
      this.lastFetchOkTs = now;
      this.state = 'CONNECTED';
      this.note = null;
      this.cacheEntries = 1;
      this.nextAllowed = now + this.spec.minIntervalMs;
      return payload;
    } catch (err) {
      this.failures += 1;
      this.lastError = err instanceof Error ? err.message : 'fetch failed';
      this.state = this.state === 'CONNECTED' ? 'DEGRADED' : this.state;
      this.note = this.lastError;
      this.nextAllowed = now + this.spec.minIntervalMs;
      return null;
    }
  }

  status(): ContextSourceSnapshot {
    const now = this.now();
    const fresh = this.lastFetchOkTs !== null && now - this.lastFetchOkTs < this.opts.pollMs * 2;
    let state: ProviderState = this.state;
    if (state === 'CONNECTED' && !fresh) {
      state = 'DEGRADED';
      this.note = this.lastFetchOkTs === null ? 'no successful fetch yet' : 'stale cache';
    }
    return {
      id: this.id,
      label: this.label,
      feedKind: 'REST',
      state,
      healthy: state === 'CONNECTED' && fresh,
      requests: this.requests,
      budget: { limit: this.spec.budget, used: this.requests, resetsAt: this.windowStart + 3_600_000 },
      lastFetchTs: this.lastFetchTs,
      lastFetchAgeMs: this.lastFetchTs === null ? null : now - this.lastFetchTs,
      cacheEntries: this.cacheEntries,
      lastError: this.lastError,
      note: this.note ?? (state === 'CONNECTED' ? `cached ${this.cacheEntries} entries` : null),
    };
  }
}

export function createContextSource(id: string, opts: ContextOptions): ContextAdapter {
  const spec = SPECS[id];
  if (!spec) throw new Error(`unknown context source: ${id}`);
  return new RestSource(spec, opts);
}

export const CONTEXT_SOURCE_IDS = Object.keys(SPECS);
