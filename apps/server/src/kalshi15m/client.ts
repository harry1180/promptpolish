/**
 * Kalshi transport — REST (public, no key) + signed websocket.
 *
 * Verified live 2026-11-20:
 *  - REST `/trade-api/v2/*` answers without credentials (series, markets,
 *    orderbook) — discovery and snapshot recovery need no key at all.
 *  - the websocket returns 401 unauthenticated; it wants Ed25519 headers
 *    KALSHI-ACCESS-KEY / -TIMESTAMP / -SIGNATURE over `ts + "GET" + path`
 *    (same scheme the predict dashboard already uses against this API).
 *
 * Reconnection, backoff and re-subscription live here so no caller ever
 * has to know whether the socket is up; the book layer only sees frames.
 * The socket factory is injectable, which is how the tests drive it.
 */
import WebSocket from 'ws';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const KALSHI_REST = 'https://api.elections.kalshi.com/trade-api/v2';
export const KALSHI_WS = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
export const KALSHI_WS_PATH = '/trade-api/ws/v2';
export const KXBTC15M = 'KXBTC15M';

/* ------------------------------------------------------------------ */
/* signing                                                             */
/* ------------------------------------------------------------------ */

export interface KalshiCreds {
  keyId: string;
  key: KeyObject;
}

export interface AuthConfig {
  /** KALSHI_API_KEY_ID */
  apiKeyId?: string | undefined;
  /** KALSHI_PRIVATE_KEY_PATH — PKCS8 PEM (or DER) Ed25519 private key */
  privateKeyPath?: string | undefined;
  /** optional pre-loaded PEM (tests) */
  pem?: string | undefined;
}

/** Headers for one signed GET. Fresh timestamp every call (ms epoch). */
export function kalshiHeaders(creds: KalshiCreds, path = KALSHI_WS_PATH, now = Date.now()): Record<string, string> {
  const ts = String(now);
  const signature = sign(null, Buffer.from(`${ts}GET${path}`), creds.key).toString('base64');
  return {
    'KALSHI-ACCESS-KEY': creds.keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signature,
  };
}

/**
 * Load creds from env. Returns null when unconfigured — the runtime then
 * runs REST-only (discovery works, the socket stays down, and the dashboard
 * says so) instead of crashing or silently retrying auth failures.
 */
export function loadCreds(cfg: AuthConfig = {}, env: Record<string, string | undefined> = process.env): KalshiCreds | null {
  const keyId = cfg.apiKeyId ?? env.KALSHI_API_KEY_ID;
  const path = cfg.privateKeyPath ?? env.KALSHI_PRIVATE_KEY_PATH;
  if (!keyId || !path) return null;
  try {
    const pem = cfg.pem ?? readFileSync(path);
    return { keyId, key: createPrivateKey(pem) };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* REST                                                                */
/* ------------------------------------------------------------------ */

export interface RestMarket {
  ticker: string;
  event_ticker?: string;
  status?: string;
  open_time?: string;
  close_time?: string;
  expected_expiration_time?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  yes_bid_size_fp?: string;
  yes_ask_size_fp?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  floor_strike?: number;
  rules_primary?: string;
  volume_fp?: string;
  open_interest_fp?: string;
  /** 'yes' | 'no' once the market is settled (empty string while live) */
  result?: string;
  /** official settlement value (the BRTI average Kalshi resolved on) */
  expiration_value?: string;
}

export interface RestClientOptions {
  fetchImpl?: typeof fetch;
  creds?: KalshiCreds | null;
  userAgent?: string;
}

/** Thin REST wrapper: JSON, sane errors, optional signing. */
export class KalshiRest {
  private readonly fetchImpl: typeof fetch;
  private readonly creds: KalshiCreds | null;
  private readonly headers: Record<string, string>;

  constructor(opts: RestClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.creds = opts.creds ?? null;
    this.headers = { accept: 'application/json', 'user-agent': opts.userAgent ?? 'cx-crypto/1.0' };
  }

  private async get<T>(pathAndQuery: string): Promise<T> {
    const url = `${KALSHI_REST}${pathAndQuery}`;
    const headers = { ...this.headers };
    if (this.creds) Object.assign(headers, kalshiHeaders(this.creds, pathAndQuery.split('?')[0]));
    const res = await this.fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`kalshi REST ${pathAndQuery} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** `GET /series/{ticker}` (fee_type / fee_multiplier / settlement sources) */
  series(ticker: string): Promise<{ series?: Record<string, unknown> }> {
    return this.get(`/series/${encodeURIComponent(ticker)}`);
  }

  /** Markets for a series by status: open | upcoming | closed | settled */
  markets(series: string, status?: string, limit = 50): Promise<{ markets?: RestMarket[]; cursor?: string }> {
    const q = [`series_ticker=${encodeURIComponent(series)}`, `limit=${limit}`];
    if (status) q.push(`status=${encodeURIComponent(status)}`);
    return this.get(`/markets?${q.join('&')}`);
  }

  /** Full resting book for one market (recovery path after a seq gap). */
  orderbook(ticker: string): Promise<{ orderbook_fp?: { yes_dollars?: unknown; no_dollars?: unknown } }> {
    return this.get(`/markets/${encodeURIComponent(ticker)}/orderbook`);
  }

  /** Open KXBTC15M market covering `now` (the window we should be watching). */
  async openMarket(series = KXBTC15M): Promise<RestMarket | null> {
    const body = await this.markets(series, 'open', 10);
    const list = body.markets ?? [];
    const now = Date.now();
    const sorted = [...list].sort((a, b) => Date.parse(a.open_time ?? '0') - Date.parse(b.open_time ?? '0'));
    return sorted.find((m) => {
      const open = Date.parse(m.open_time ?? '');
      const close = Date.parse(m.close_time ?? '');
      return Number.isFinite(open) && Number.isFinite(close) && now >= open && now < close;
    }) ?? sorted[0] ?? null;
  }
}

/* ------------------------------------------------------------------ */
/* websocket                                                           */
/* ------------------------------------------------------------------ */

export interface StreamSocket {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
  send(data: string): void;
  close(): void;
}

export interface FrameHandlers {
  /** orderbook_snapshot / orderbook_delta for our markets */
  onBook?: (frame: Record<string, unknown>) => void;
  /** trade frames — GLOBAL channel: the runtime filters by market ticker */
  onTrade?: (frame: Record<string, unknown>) => void;
  /** any other data frame (ticker, market_lifecycle_v2, ...) */
  onOther?: (frame: Record<string, unknown>) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
}

export interface KalshiWsOptions {
  creds: KalshiCreds | null;
  /** market tickers to follow on the book channel (book snapshot + deltas) */
  markets: () => string[];
  handlers: FrameHandlers;
  socketFactory?: (url: string, headers: Record<string, string>) => StreamSocket;
  now?: () => number;
  /** reconnect backoff bounds (ms) */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * One persistent socket: global `trade` stream + `orderbook_delta` for the
 * KXBTC15M markets we follow. Reconnects with capped exponential backoff,
 * re-signs (the timestamp is only valid for a short window) and re-subscribes
 * on every connect, then asks the runtime for the current market list.
 *
 * Deliberately NOT subscribed: the global `ticker` channel — it delivers
 * ~1,800 msg/s for every market on the exchange and we derive top-of-book
 * from our own book, which is both cheaper and sequence-checked.
 */
export class KalshiWs {
  private readonly opts: KalshiWsOptions;
  private socket: StreamSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private opened = false;
  private sid = 0;
  readonly stats = {
    connects: 0, reconnects: 0, frames: 0, errors: 0,
    lastFrameAt: 0, lastError: null as string | null, authed: false,
  };

  constructor(opts: KalshiWsOptions) {
    this.opts = opts;
  }

  get live(): boolean {
    return this.socket !== null;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const s = this.socket;
    this.socket = null;
    try { s?.close(); } catch { /* already gone */ }
  }

  private connect(): void {
    if (this.stopped) return;
    if (!this.opts.creds) {
      this.stats.lastError = 'no credentials (KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_PATH unset)';
      this.opts.handlers.onDisconnect?.('no_credentials');
      return;
    }
    const headers = kalshiHeaders(this.opts.creds, KALSHI_WS_PATH, (this.opts.now ?? Date.now)());
    let socket: StreamSocket;
    try {
      socket = this.factory()(KALSHI_WS, headers);
    } catch (err) {
      this.stats.errors += 1;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.attempts = 0;
      this.opened = true;
      this.stats.connects += 1;
      this.stats.authed = true;
      this.opts.handlers.onConnect?.();
      // global print tape (Kalshi does not filter `trade` by market: the
      // runtime drops foreign tickers)
      this.send({ id: ++this.sid, cmd: 'subscribe', params: { channels: ['trade'] } });
      this.subscribeMarkets();
    });
    socket.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : String(data);
      this.stats.frames += 1;
      this.stats.lastFrameAt = (this.opts.now ?? Date.now)();
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      this.dispatch(frame);
    });
    socket.on('error', (err: Error) => {
      this.stats.errors += 1;
      this.stats.lastError = err.message;
      this.stats.authed = false;
    });
    socket.on('close', () => {
      this.socket = null;
      this.opened = false;
      this.stats.authed = false;
      this.opts.handlers.onDisconnect?.('closed');
      this.scheduleReconnect();
    });
  }

  private factory(): (url: string, headers: Record<string, string>) => StreamSocket {
    if (this.opts.socketFactory) return this.opts.socketFactory;
    return (url, headers) => new WebSocket(url, { headers }) as unknown as StreamSocket;
  }

  private dispatch(frame: Record<string, unknown>): void {
    const type = typeof frame.type === 'string' ? frame.type : '';
    if (type === 'error') {
      this.stats.errors += 1;
      this.stats.lastError = JSON.stringify(frame.msg ?? frame).slice(0, 300);
      return;
    }
    if (type === 'orderbook_snapshot' || type === 'orderbook_delta') {
      this.opts.handlers.onBook?.(frame);
      return;
    }
    if (type === 'trade') {
      this.opts.handlers.onTrade?.(frame);
      return;
    }
    this.opts.handlers.onOther?.(frame);
  }

  /** Subscribe the current market list (idempotent: re-subscribing a market
   *  re-delivers its book snapshot, which is exactly how we recover gaps). */
  subscribeMarkets(): void {
    const markets = this.opts.markets().filter(Boolean);
    if (markets.length === 0 || !this.socket) return;
    this.send({
      id: ++this.sid, cmd: 'subscribe',
      params: { channels: ['orderbook_delta'], market_tickers: markets },
    });
  }

  /** Force a snapshot re-delivery for gap recovery (resubscribe is cheap). */
  refreshSnapshot(): void {
    this.subscribeMarkets();
  }

  private send(payload: unknown): void {
    // never write to a CONNECTING/CLOSED socket: discovery can ask for a
    // subscription before the handshake finishes (it used to raise
    // "readyState 0 (CONNECTING)" — the open handler re-subscribes anyway)
    if (!this.opened || !this.socket) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (err) {
      this.stats.errors += 1;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const min = this.opts.minBackoffMs ?? 1_000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** Math.min(this.attempts, 6));
    this.attempts += 1;
    if (this.attempts > 1) this.stats.reconnects += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}