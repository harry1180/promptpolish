/**
 * Shared WebSocket feed lifecycle for the multi-exchange layer.
 *
 * One `WsFeed` = one venue connection. It owns connect/reconnect with capped
 * backoff, provider-specific subscribe frames, heartbeat replies, idle
 * detection and the health metrics every `ProviderSnapshot` reports (event
 * counts, rate, exchange->receive latency percentiles, reconnects, errors,
 * per-symbol book freshness).
 *
 * The feed is DATA ONLY: events leave through `onEvent`, which the registry
 * routes to the shadow store/feature engine — never to the trading path.
 *
 * Erasable-TypeScript only (no parameter properties / enums): node --test runs
 * the server sources through Node's strip-only transpiler.
 */
import WebSocket from 'ws';
import {
  deriveState,
  type CanonicalEvent,
  type ExchangeAdapter,
  type LatencyStats,
  type ProviderSnapshot,
  type ProviderState,
  type VenueQuote,
} from './types.ts';

export interface StreamSocket {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
  send(data: string): void;
  close(): void;
}

/** What a control handler wants done with the socket. */
export interface ControlAction {
  send?: string;
  close?: boolean;
}

/** Per-venue adapter configuration handed to every `create*Feed` factory. */
export interface VenueFeedConfig {
  /** canonical base assets to monitor (XBT is already normalized to BTC) */
  symbols: string[];
  /** preferred quote for this venue (USD / USDT / USDC) */
  quote: string;
  onEvent: (ev: CanonicalEvent) => void;
  socketFactory?: (url: string) => unknown;
  now?: () => number;
}

export interface ParseContext {
  symbols: Set<string>;
  now: number;
}

export interface WsFeedOptions {
  id: string;
  label: string;
  url: string;
  symbols: string[];
  channels: string[];
  /** frames sent immediately after the socket opens */
  subscribeFrames: () => string[];
  /** native frame -> canonical events (return [] for control frames) */
  parse: (text: string, ctx: ParseContext) => CanonicalEvent[];
  /** control frames (acks, errors, heartbeats): optionally send a reply
   *  and/or close the socket (protocol-level reconnect requests). */
  onControl?: (text: string) => ControlAction | null;
  /** control messages worth surfacing in `snapshot().note` (subscription
   *  rejections arrive as normal frames, never as errors) */
  onNote?: (text: string) => string | null;
  /** app-level heartbeat interval, ms (0 = none) */
  heartbeatMs?: number;
  /** heartbeat frame builder, sent on `heartbeatMs` while connected */
  heartbeatFrame?: (() => string | null) | undefined;
  /** force a reconnect after this long without any frame (ms) */
  idleReconnectMs?: number;
  onEvent?: (event: CanonicalEvent) => void;
  socketFactory?: (url: string) => StreamSocket;
  now?: () => number;
  maxBackoffMs?: number;
}

const LATENCY_SAMPLES = 256;

function defaultFactory(url: string): StreamSocket {
  return new WebSocket(url, { handshakeTimeout: 10_000 }) as unknown as StreamSocket;
}

function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

export class WsFeed implements ExchangeAdapter {
  readonly id: string;
  readonly label: string;
  readonly feedKind = 'WEBSOCKET' as const;
  readonly channels: string[];
  readonly symbols: string[];

  private readonly opts: WsFeedOptions;
  private socket: StreamSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private attempts = 0;
  private hasStarted = false;
  private stopped = true;
  private connecting = false;
  private everConnected = false;

  private eventCount = 0;
  private eventStamps: number[] = [];
  private lastEventTs: number | null = null;
  private lastAckTs: number | null = null;
  private lastError: string | null = null;
  private reconnects = 0;
  private errors = 0;
  private latencies: number[] = [];
  private symbolState = new Map<string, { lastTs: number; levels: number; valid: boolean }>();
  private quotes = new Map<string, VenueQuote>();
  private note: string | null = null;

  constructor(opts: WsFeedOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.label = opts.label;
    this.symbols = [...opts.symbols];
    this.channels = [...opts.channels];
    for (const s of this.symbols) this.symbolState.set(s, { lastTs: 0, levels: 0, valid: false });
  }

  /** transport-level: socket object exists */
  get connected(): boolean {
    return this.socket !== null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.hasStarted = true;
    this.connect();
    const idleMs = this.opts.idleReconnectMs ?? 60_000;
    this.idleTimer = setInterval(() => {
      if (this.stopped || !this.socket) return;
      const last = this.lastEventTs ?? 0;
      if (Date.now() - last > idleMs && this.everConnected) {
        this.note = `no frames for ${Math.round((Date.now() - last) / 1000)}s — recycling socket`;
        try { this.socket.close(); } catch { /* close handler reconnects */ }
      }
    }, Math.max(5_000, Math.floor(idleMs / 3)));
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    if (this.socket) { try { this.socket.close(); } catch { /* already gone */ } this.socket = null; }
    this.connecting = false;
  }

  private connect(): void {
    if (this.stopped) return;
    const factory = this.opts.socketFactory ?? defaultFactory;
    let socket: StreamSocket;
    this.connecting = true;
    try {
      socket = factory(this.opts.url);
    } catch (err) {
      this.connecting = false;
      this.errors += 1;
      this.lastError = err instanceof Error ? err.message : 'socket factory failed';
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.connecting = false;
      this.everConnected = true;
      this.attempts = 0;
      this.lastAckTs = Date.now();
      try {
        for (const frame of this.opts.subscribeFrames()) socket.send(frame);
      } catch (err) {
        this.errors += 1;
        this.lastError = err instanceof Error ? err.message : 'subscribe failed';
      }
      if (this.opts.heartbeatMs && this.opts.heartbeatFrame) {
        this.heartbeatTimer = setInterval(() => {
          const frame = this.opts.heartbeatFrame?.();
          if (frame && this.socket) { try { this.socket.send(frame); } catch { /* next beat retries */ } }
        }, this.opts.heartbeatMs);
      }
    });

    socket.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : String(data);
      const now = (this.opts.now ?? Date.now)();
      let events: CanonicalEvent[] = [];
      try {
        events = this.opts.parse(text, { symbols: new Set(this.symbols), now });
      } catch (err) {
        this.errors += 1;
        this.lastError = err instanceof Error ? err.message : 'parse failed';
        return; // a bad frame never takes the socket down
      }
      if (this.opts.onNote) {
        try {
          const note = this.opts.onNote(text);
          if (note) this.note = note;
        } catch { /* note extraction is best-effort */ }
      }
      if (this.opts.onControl) {
        try {
          const action = this.opts.onControl(text);
          if (action?.send && this.socket) this.socket.send(action.send);
          if (action?.close && this.socket) this.socket.close();
        } catch { /* control handling is best-effort */ }
      }
      for (const ev of events) this.record(ev, now);
    });

    socket.on('error', (err: Error) => {
      this.errors += 1;
      this.lastError = err.message;
    });

    socket.on('close', () => {
      this.socket = null;
      this.connecting = false;
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
      if (!this.stopped) {
        this.reconnects += 1;
        this.scheduleReconnect();
      }
    });
  }

  private record(ev: CanonicalEvent, now: number): void {
    this.eventCount += 1;
    this.lastEventTs = now;
    this.eventStamps.push(now);
    if (this.eventStamps.length > 600) this.eventStamps.splice(0, this.eventStamps.length - 600);
    if (ev.exchangeTs !== null && ev.exchangeTs > 0) {
      const d = now - ev.exchangeTs;
      // only plausible receive delays are measurable (clock skew shows as a
      // huge number; clamp and count separately rather than polluting p95)
      if (d >= 0 && d < 60_000) {
        this.latencies.push(d);
        if (this.latencies.length > LATENCY_SAMPLES) this.latencies.shift();
      }
    }
    const st = this.symbolState.get(ev.base);
    if (st && (ev.type === 'book_snapshot' || ev.type === 'book_update' || ev.type === 'ticker')) {
      st.lastTs = now;
      st.levels = Math.max(st.levels, (ev.bids?.length ?? 0) + (ev.asks?.length ?? 0));
      st.valid = ev.bookValid;
    } else if (st && ev.type === 'trade') {
      st.lastTs = now;
    }
    if (ev.bid !== null || ev.ask !== null || ev.price !== null) {
      const bid = ev.bid;
      const ask = ev.ask;
      const mid = bid !== null && ask !== null ? (bid + ask) / 2 : ev.price;
      const spreadBps = bid !== null && ask !== null && mid ? ((ask - bid) / mid) * 10_000 : null;
      this.quotes.set(ev.base, {
        provider: this.id,
        symbol: ev.base,
        quote: ev.quote,
        bid,
        ask,
        mid,
        last: ev.price,
        spreadBps: spreadBps === null ? null : Math.round(spreadBps * 100) / 100,
        ts: now,
      });
    }
    if (this.opts.onEvent) {
      try { this.opts.onEvent(ev); } catch { /* store/feature failures never affect ingest */ }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const delay = Math.min(max, 500 * 2 ** Math.min(this.attempts, 6));
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private eventsPerMin(now: number): number {
    const cutoff = now - 60_000;
    return this.eventStamps.filter((t) => t > cutoff).length;
  }

  latency(): LatencyStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return { p50: pct(sorted, 50), p95: pct(sorted, 95), samples: sorted.length };
  }

  snapshot(): ProviderSnapshot {
    const now = (this.opts.now ?? Date.now)();
    const derived: { state: ProviderState; healthy: boolean; note: string | null } = deriveState({
      enabled: true,
      connected: this.connected,
      connecting: this.connecting,
      configured: this.symbols.length > 0,
      events: this.eventCount,
      lastEventTs: this.lastEventTs,
      now,
      lastError: this.lastError,
    });
    if (!this.hasStarted) {
      // never started (workers off) is CONFIGURED, not a broken connection
      derived.state = 'CONFIGURED';
      derived.healthy = false;
      derived.note = 'adapter loaded, not started';
    }
    const book = [...this.symbolState.entries()].map(([symbol, st]) => ({
      symbol,
      levels: st.levels,
      valid: st.levels > 0 ? st.valid : true, // no book channel -> nothing to invalidate
      ageMs: st.lastTs === 0 ? null : now - st.lastTs,
    }));
    return {
      id: this.id,
      label: this.label,
      feedKind: 'WEBSOCKET',
      state: derived.state,
      healthy: derived.healthy,
      connected: this.connected,
      channels: [...this.channels],
      symbols: [...this.symbols],
      symbolCount: this.symbols.length,
      events: this.eventCount,
      eventsPerMin: this.eventsPerMin(now),
      lastEventTs: this.lastEventTs,
      lastEventAgeMs: this.lastEventTs === null ? null : now - this.lastEventTs,
      lastAckTs: this.lastAckTs,
      reconnects: this.reconnects,
      errors: this.errors,
      lastError: this.lastError,
      latency: this.latency(),
      book,
      quotes: [...this.quotes.values()],
      note: this.note ?? derived.note,
    };
  }
}

/** Recompute latency percentiles from an array (exported for tests). */
export function latencyPercentiles(samples: number[]): { p50: number | null; p95: number | null } {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: pct(sorted, 50), p95: pct(sorted, 95) };
}
