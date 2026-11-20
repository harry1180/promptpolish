/**
 * Realtime price stream for the crypto book.
 *
 * Primary: Kraken's websocket ticker channel (one persistent connection for
 * the whole universe, tick-level updates with the exchange's own timestamp).
 * Fallback: REST polling every `restPollMs` whenever the socket is down —
 * reconnects with backoff and hands back over to the socket when it returns.
 * Nothing else in the module knows which one is live: both emit the same
 * Quote shape through `onTick`.
 *
 * The socket is injectable so tests drive it without a network.
 */
import WebSocket from 'ws';
import type { Quote } from '@promptslim/tucore';

export type TickQuote = Quote & { bid?: number; ask?: number };

export interface StreamSocket {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
  send(data: string): void;
  close(): void;
}

export interface PriceStreamOptions {
  symbols: string[];
  onTick: (q: TickQuote) => void;
  /** called on a timer while the socket is down (should hit REST once) */
  restPoll: () => Promise<unknown>;
  restPollMs?: number;
  socketFactory?: (url: string) => StreamSocket;
  now?: () => number;
  /**
   * Additional Kraken v2 channels subscribed on THIS connection (micro
   * module, feature-flagged). Empty/absent = byte-identical to the original
   * behaviour: only `ticker` is ever requested.
   */
  extraChannels?: string[];
  /**
   * Observer hook: every raw frame, invoked AFTER the existing ticker parse
   * has run, inside a try/catch — a throwing observer can never affect the
   * production ingest path. Used by the shadow microstructure engine.
   */
  onRawMessage?: (text: string) => void;
  /**
   * Additional raw-frame observers, invoked after the ticker parse like
   * `onRawMessage`. A list (not a single callback) because two independent
   * shadow consumers exist — the micro engine and the BTC spot tape — and
   * neither may steal the other's hook. Runs inside try/catch: an observer
   * that throws can never affect the production ingest path.
   */
  rawObservers?: Array<(text: string) => void>;
}

/** Kraken's v2 websocket names bitcoin BTC. The v1 legacy alias is rejected
 *  there — `XBT/USD` answers `Currency pair not supported XBT/USD` (verified
 *  live 2026-11-05: 24/25 of our pairs subscribe, only XBT fails), which left
 *  the benchmark with no ticker and a quote that only moved on the 300s scan's
 *  REST poll. Inbound decoding still accepts XBT (see parseTickerMessage). */
export function wsSymbol(symbol: string): string {
  return `${symbol.toUpperCase()}/USD`;
}

const WS_URL = 'wss://ws.kraken.com/v2';

function defaultFactory(url: string): StreamSocket {
  return new WebSocket(url) as unknown as StreamSocket;
}

/** Parse one Kraken v2 ticker message into quotes (empty when not ours). */
export function parseTickerMessage(raw: unknown, symbols: Set<string>, now: number): TickQuote[] {
  let msg: {
    channel?: string;
    data?: Array<{
      symbol?: string; last?: number; bid?: number; ask?: number;
      volume?: number; change?: number; timestamp?: string; time?: string;
    }>;
  };
  try {
    msg = JSON.parse(String(raw)) as typeof msg;
  } catch {
    return [];
  }
  if (msg.channel !== 'ticker' || !Array.isArray(msg.data)) return [];
  const out: TickQuote[] = [];
  for (const row of msg.data) {
    if (!row.symbol) continue;
    // "BTC/USD" -> "BTC" (XBT is BTC everywhere else in the app)
    const base = row.symbol.split('/')[0]?.toUpperCase();
    const symbol = base === 'XBT' ? 'BTC' : base;
    if (!symbol || !symbols.has(symbol)) continue;
    const price = Number(row.last ?? row.bid);
    if (!Number.isFinite(price) || price <= 0) continue;
    // Kraken's field is `timestamp` (verified live); `time` kept as a fallback
    const stamp = row.timestamp ?? row.time;
    const ts = stamp ? Date.parse(stamp) : now;
    // `change` is the absolute move vs 24h ago — a real previous close
    const change = Number(row.change);
    const prevClose = Number.isFinite(change) && change !== 0 ? price - change : price;
    out.push({
      symbol,
      price,
      prevClose: prevClose > 0 ? prevClose : price,
      ts: Number.isFinite(ts) ? ts : now,
      bid: Number.isFinite(Number(row.bid)) ? Number(row.bid) : undefined,
      ask: Number.isFinite(Number(row.ask)) ? Number(row.ask) : undefined,
      provider: 'kraken-ws',
      freshness: 'REALTIME',
    });
  }
  return out;
}

export class CryptoPriceStream {
  private opts: Required<Pick<PriceStreamOptions, 'restPollMs'>> & PriceStreamOptions;
  private socket: StreamSocket | null = null;
  private restTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private _symbols: Set<string>;

  constructor(options: PriceStreamOptions) {
    this.opts = { restPollMs: 5_000, ...options };
    this._symbols = new Set(options.symbols.map((s) => s.toUpperCase()));
  }

  get symbols(): Set<string> {
    return this._symbols;
  }

  /** Universe membership changed (rank refresh): re-subscribe from scratch —
   *  the cheapest correct way to apply a new symbol list on Kraken WS. */
  updateSymbols(symbols: string[]): void {
    const next = new Set(symbols.map((s) => s.toUpperCase()));
    if (next.size === this._symbols.size && [...next].every((s) => this._symbols.has(s))) return;
    this._symbols = next;
    if (this.socket) {
      try { this.socket.close(); } catch { /* already gone; close handler reconnects */ }
    }
  }

  /** true while the websocket is our active transport */
  get live(): boolean {
    return this.socket !== null;
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.startRestPolling(); // belt and braces: REST keeps data fresh until
    // (and while) the socket is down; stopped once live
  }

  private startRestPolling(): void {
    if (this.restTimer) return;
    this.restTimer = setInterval(() => {
      if (this.live) return; // socket is delivering — no need to hammer REST
      void this.opts.restPoll().catch(() => { /* next tick retries */ });
    }, this.opts.restPollMs);
    void this.opts.restPoll().catch(() => { /* first poll right away */ });
  }

  private connect(): void {
    if (this.stopped) return;
    const factory = this.opts.socketFactory ?? defaultFactory;
    let socket: StreamSocket;
    try {
      socket = factory(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.attempts = 0;
      const symbols = [...this._symbols].map(wsSymbol);
      socket.send(JSON.stringify({
        method: 'subscribe',
        params: { channel: 'ticker', symbol: symbols },
      }));
      // opt-in extra channels on the SAME connection (never a second socket)
      for (const channel of this.opts.extraChannels ?? []) {
        socket.send(JSON.stringify({ method: 'subscribe', params: { channel, symbol: symbols } }));
      }
    });
    socket.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : String(data);
      for (const q of parseTickerMessage(text, this._symbols, (this.opts.now ?? Date.now)())) {
        this.opts.onTick(q);
      }
      // observer runs AFTER the production parse, never in front of it
      if (this.opts.onRawMessage) {
        try { this.opts.onRawMessage(text); } catch { /* observer must not break ingest */ }
      }
      for (const obs of this.opts.rawObservers ?? []) {
        try { obs(text); } catch { /* observers never break ingest */ }
      }
    });
    socket.on('error', () => { /* 'close' follows and drives the fallback */ });
    socket.on('close', () => {
      this.socket = null;
      this.startRestPolling(); // keep the book warm while we reconnect
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts, 5));
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.restTimer) { clearInterval(this.restTimer); this.restTimer = null; }
    if (this.socket) { try { this.socket.close(); } catch { /* already gone */ } this.socket = null; }
  }
}
