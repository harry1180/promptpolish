/**
 * Canonical multi-exchange market-data types.
 *
 * Every venue adapter normalizes its native frames into `CanonicalEvent`, so
 * the feature engine, the store and the dashboard never branch on provider
 * rules (Kraken XBT vs BTC, USD vs USDT, ...).
 *
 * DATA ONLY: nothing in this module writes to the trading path — see
 * docs/XCHANGE.md. Fields the feed does not carry stay `null` (never invented).
 */

/** Lifecycle of any source, live WebSocket or lower-frequency REST. */
export type ProviderState =
  | 'DISABLED'
  | 'CONFIGURED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'DISCONNECTED'
  | 'UNAVAILABLE'
  | 'NEEDS_CONFIGURATION';

export type FeedKind = 'WEBSOCKET' | 'REST';

export type EventType = 'trade' | 'ticker' | 'book_snapshot' | 'book_update';

export interface CanonicalEvent {
  /** provider id, e.g. 'coinbase' */
  provider: string;
  /** provider-native instrument id, e.g. 'BTC-USD', 'BTCUSDT' */
  instrument: string;
  /** canonical base asset (XBT -> BTC) */
  base: string;
  /** canonical quote asset (USD / USDT / USDC — never merged) */
  quote: string;
  productType: 'SPOT' | 'FUTURES';
  type: EventType;
  /** trade id / sequence reference when the feed provides one */
  eventId: string | null;
  /** exchange timestamp, ms epoch, null when the feed sends none */
  exchangeTs: number | null;
  /** local receive timestamp, ms epoch */
  recvTs: number;
  /** after normalization + store handoff, ms epoch */
  processTs: number;
  price: number | null;
  size: number | null;
  /** aggressor side when the feed exposes it, else null */
  side: 'buy' | 'sell' | null;
  bid: number | null;
  bidQty: number | null;
  ask: number | null;
  askQty: number | null;
  /** full top-N book when the feed delivers one (snapshot or depth stream) */
  bids: Array<[number, number]> | null;
  asks: Array<[number, number]> | null;
  seq: number | null;
  channel: string | null;
  /** only 'REALTIME' — REST context sources never emit CanonicalEvent */
  freshness: 'REALTIME';
  /** true when a book/sequence check passed for this event */
  bookValid: boolean;
}

/** Per-symbol top-of-book as seen from one venue. */
export interface VenueQuote {
  provider: string;
  symbol: string;
  quote: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  spreadBps: number | null;
  ts: number;
}

export interface LatencyStats {
  /** exchangeTs -> recvTs, ms; null when the feed sends no timestamp */
  p50: number | null;
  p95: number | null;
  samples: number;
}

export interface ProviderSnapshot {
  id: string;
  label: string;
  feedKind: FeedKind;
  state: ProviderState;
  /** CONNECTED is transport only — healthy also needs fresh valid data */
  healthy: boolean;
  connected: boolean;
  channels: string[];
  symbols: string[];
  symbolCount: number;
  events: number;
  eventsPerMin: number;
  lastEventTs: number | null;
  lastEventAgeMs: number | null;
  lastAckTs: number | null;
  reconnects: number;
  errors: number;
  lastError: string | null;
  latency: LatencyStats;
  /** top-of-book health per symbol; empty when the feed carries no book */
  book: Array<{ symbol: string; levels: number; valid: boolean; ageMs: number | null }>;
  quotes: VenueQuote[];
  /** human-readable reason for anything not CONNECTED/healthy */
  note: string | null;
}

/** Lower-frequency REST research source (DEX Screener / GeckoTerminal / CoinGecko). */
export interface ContextSourceSnapshot {
  id: string;
  label: string;
  feedKind: FeedKind;
  state: ProviderState;
  healthy: boolean;
  /** request budget observed this window */
  requests: number;
  budget: { limit: number; used: number; resetsAt: number | null };
  lastFetchTs: number | null;
  lastFetchAgeMs: number | null;
  cacheEntries: number;
  lastError: string | null;
  note: string | null;
}

/** Everything the provider API returns. */
export interface ProvidersResponse {
  ok: true;
  executionMode: 'PAPER_ONLY';
  /** data-only: these feeds never touch the broker */
  decisionImpact: 'NONE';
  generatedAt: number;
  exchanges: ProviderSnapshot[];
  context: ContextSourceSnapshot[];
  /** venues with an adapter design but NOT wired (never silently enabled) */
  pending: string[];
  /** Kraken (the existing production feed) reported the same way */
  reference: ProviderSnapshot;
}

export interface ExchangeAdapter {
  readonly id: string;
  readonly label: string;
  readonly feedKind: FeedKind;
  readonly channels: string[];
  readonly symbols: string[];
  start(): void;
  stop(): void;
  snapshot(): ProviderSnapshot;
}

/** Milliseconds after which a venue without a fresh event counts as degraded. */
export const STALE_AFTER_MS = 30_000;

/** Derive state+health from transport and data facts. CONNECTED alone never
 *  means healthy: a live socket with a frozen feed reports DEGRADED. */
export function deriveState(input: {
  enabled: boolean;
  connected: boolean;
  connecting: boolean;
  configured: boolean;
  events: number;
  lastEventTs: number | null;
  now: number;
  needsConfig?: boolean;
  lastError?: string | null;
}): { state: ProviderState; healthy: boolean; note: string | null } {
  if (input.needsConfig) return { state: 'NEEDS_CONFIGURATION', healthy: false, note: 'missing API key / configuration' };
  if (!input.enabled) return { state: 'DISABLED', healthy: false, note: 'disabled by configuration' };
  if (!input.configured) return { state: 'CONFIGURED', healthy: false, note: 'adapter loaded, no instruments configured' };
  if (input.connecting) return { state: 'CONNECTING', healthy: false, note: 'handshake in progress' };
  if (!input.connected) {
    return {
      state: input.events > 0 ? 'DISCONNECTED' : 'UNAVAILABLE',
      healthy: false,
      note: input.lastError ?? 'socket closed',
    };
  }
  const age = input.lastEventTs === null ? Infinity : input.now - input.lastEventTs;
  if (input.events === 0) return { state: 'CONNECTED', healthy: false, note: 'connected, no market data received yet' };
  if (age > STALE_AFTER_MS) {
    return { state: 'DEGRADED', healthy: false, note: `no market data for ${Math.round(age / 1000)}s` };
  }
  return { state: 'CONNECTED', healthy: true, note: null };
}
