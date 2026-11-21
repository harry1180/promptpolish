/**
 * Crypto job cycle — the scheduler behind /crypto.
 *
 * Unlike the equities book there are no market sessions: the cycle runs 24/7
 * and gates each job by its own due time instead of by session kind.
 *
 *   universe_seed/refresh  on start, then 6h  Kraken tradability + market-cap
 *                          ranking with hysteresis (seeds the first 25)
 *   quote_ingest     5s   REST poll whenever the websocket is down
 *                          (the socket's own REST fallback does the same)
 *   order_processing 15s  fill PENDING spot orders with fee-aware fills
 *   position_monitor 10s  mark to market, fire price-based exits
 *   snapshot         60s  equity / cash / BTC benchmark row
 *   bar_backfill    600s  daily bars for the universe + BTC
 *   signal_scan     300s  strategy -> fusion (learned weights) -> orders
 *   settle_hourly     1h  daily-bar exit evaluation
 *   knowledge        30m  learnFromOutcome on fresh closes (once each) +
 *                          weight/threshold refit from this book's outcomes
 */
import type { DatabaseSync } from 'node:sqlite';
import { etDate } from '@promptslim/tucore';
import { learnFromOutcome, refreshKnowledge } from '../tradingusa/adaptive.ts';
import type { CryptoConfig } from './config.ts';
import {
  CRYPTO_BENCHMARK, CRYPTO_PORTFOLIO, ensureSpotPortfolio, loadBars,
  monitorPositions, processOrders, settleEndOfDay,
} from './broker.ts';
import { activeSymbols, ingestTick, refreshBars, runCryptoScan, CRYPTO_STRATEGY } from './engine.ts';
import type { CryptoMarketDataProvider } from './providers/types.ts';
import type { CryptoPriceStream } from './stream.ts';
import type { TickTape } from './tape.ts';
import {
  decideUniverse, fetchRanking, fetchTradable, loadUniverseStates, saveUniverseStates, seedStates,
} from './universe.ts';

export interface CryptoSchedulerDeps {
  db: DatabaseSync;
  provider: CryptoMarketDataProvider;
  config: CryptoConfig;
  stream?: CryptoPriceStream | null;
  /** entry-confirmation tape (observer); absent = the pullback leg reports NO_DATA */
  tape?: TickTape | undefined;
  cycleMs?: number;
}

/** Equity = cash + open positions marked at the last quote. The benchmark is
 *  BTC bought with the same starting capital (buy-and-hold, no fees). */
export function snapshotEquity(db: DatabaseSync, config: CryptoConfig, now = Date.now()): {
  equity: number; cash: number; unrealized: number; benchmark: number;
} {
  const cash = (db.prepare('SELECT cash FROM paper_portfolios WHERE kind = ?').get(CRYPTO_PORTFOLIO) as { cash: number } | undefined)?.cash
    ?? config.startCapital;
  const positions = db
    .prepare('SELECT qty, current_price, entry_price FROM paper_positions WHERE exit_ts IS NULL')
    .all() as unknown as Array<{ qty: number; current_price: number | null; entry_price: number }>;
  const unrealized = positions.reduce((s, p) => s + ((p.current_price ?? p.entry_price) - p.entry_price) * p.qty, 0);
  const equity = cash + positions.reduce((s, p) => s + p.qty * (p.current_price ?? p.entry_price), 0);

  const btcNow = loadBars(db, CRYPTO_BENCHMARK).at(-1)?.close ?? 0;
  let btcStart = Number(
    (db.prepare(`SELECT value FROM tu_config WHERE key = 'btc_start'`).get() as { value: string } | undefined)?.value ?? 0,
  );
  if (!btcStart && btcNow > 0) {
    btcStart = btcNow;
    db.prepare(`INSERT INTO tu_config (key, value) VALUES ('btc_start', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(btcNow));
  }
  const benchmark = btcStart > 0 && btcNow > 0 ? config.startCapital * (btcNow / btcStart) : config.startCapital;

  db.prepare(
    `INSERT INTO portfolio_snapshots (portfolio, ts, equity, cash, realized, unrealized, exposure, benchmark_equity)
     VALUES (?,?,?,?,0,?,?,?)`,
  ).run(CRYPTO_PORTFOLIO, now, equity, cash, unrealized, equity - cash, benchmark);
  return { equity, cash, unrealized, benchmark };
}

/** Kraken tradability + market-cap ranking with hysteresis; logs every change.
 *  Seeds the first membership when the table is empty. Keeps the old universe
 *  untouched when either feed fails. */
export async function refreshUniverse(
  db: DatabaseSync,
  now = Date.now(),
): Promise<{ members: number; changed: boolean; seeded: boolean } | null> {
  let states = loadUniverseStates(db);
  if (states.length > 0) {
    // normal path: refresh clocks against the latest ranking
    const tradable = await fetchTradable();
    if (tradable.size === 0) return null;
    const ranking = await fetchRanking(tradable);
    if (ranking.length === 0) return null;
    const decision = decideUniverse(states, ranking, now);
    saveUniverseStates(db, decision.states, now);
    logMembership(db, now, decision.added, 'ADD');
    logMembership(db, now, decision.dropped, 'DROP');
    return {
      members: decision.symbols.length,
      changed: decision.added.length + decision.dropped.length > 0,
      seeded: false,
    };
  }

  // cold start: seed the first 25 immediately (no hysteresis on day one)
  const tradable = await fetchTradable();
  if (tradable.size === 0) return null;
  const ranking = await fetchRanking(tradable);
  if (ranking.length === 0) return null;
  states = seedStates(ranking);
  const decision = decideUniverse(states, ranking, now);
  saveUniverseStates(db, decision.states, now);
  logMembership(db, now, decision.symbols, 'SEED');
  return { members: decision.symbols.length, changed: true, seeded: true };
}

function logMembership(db: DatabaseSync, now: number, symbols: string[], action: 'ADD' | 'DROP' | 'SEED'): void {
  for (const symbol of symbols) {
    db.prepare('INSERT INTO crypto_universe_log (ts, action, symbol, detail) VALUES (?,?,?,?)')
      .run(now, action, symbol, JSON.stringify({ action, symbol }));
    db.prepare('INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?,?,?,?,?)')
      .run(now, 'universe_change', 'universe', symbol, JSON.stringify({ action, symbol }));
  }
}

export class CryptoScheduler {
  private readonly db: DatabaseSync;
  private readonly provider: CryptoMarketDataProvider;
  private readonly config: CryptoConfig;
  private readonly stream: CryptoPriceStream | null;
  private readonly tape: TickTape | undefined;
  private readonly cycleMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lastRun = new Map<string, number>();
  readonly errors: Array<{ job: string; at: number; message: string }> = [];
  running = false;

  constructor(deps: CryptoSchedulerDeps) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.config = deps.config;
    this.stream = deps.stream ?? null;
    this.tape = deps.tape;
    this.cycleMs = deps.cycleMs ?? 5_000;
  }

  private due(name: string, intervalMs: number, now: number): boolean {
    const last = this.lastRun.get(name) ?? 0;
    if (now - last < intervalMs) return false;
    this.lastRun.set(name, now);
    return true;
  }

  /** Every job result lands in system_jobs (OK/ERROR) so the UI can show that
   *  the 24/7 cycle is alive, and failures are visible without reading logs. */
  private async runJob(name: string, fn: () => unknown | Promise<unknown>): Promise<unknown> {
    const started = Date.now();
    try {
      const out = await fn();
      this.db.prepare(
        `INSERT INTO system_jobs (name, schedule, last_run, last_status, duration_ms, last_error, runs)
         VALUES (?, 'crypto', ?, 'OK', ?, NULL, 1)
         ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run, last_status = 'OK',
           duration_ms = excluded.duration_ms, last_error = NULL, runs = system_jobs.runs + 1`,
      ).run(name, started, Date.now() - started);
      this.running = true;
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.errors.push({ job: name, at: started, message });
      if (this.errors.length > 50) this.errors.shift();
      this.db.prepare(
        `INSERT INTO system_jobs (name, schedule, last_run, last_status, duration_ms, last_error, runs)
         VALUES (?, 'crypto', ?, 'ERROR', ?, ?, 1)
         ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run, last_status = 'ERROR',
           duration_ms = excluded.duration_ms, last_error = excluded.last_error, runs = system_jobs.runs + 1`,
      ).run(name, started, Date.now() - started, message);
      this.running = true;
      return null;
    }
  }

  /** One pass over every job, each gated by its own due time. */
  async runCycle(now = Date.now()): Promise<void> {
    const { db, provider, config } = this;
    const symbols = activeSymbols(db);

    /* ---------- data ---------- */
    if (this.due('universe_refresh', 6 * 3_600_000, now)) {
      await this.runJob('universe_refresh', () => refreshUniverse(db, now));
      // membership may have changed: re-subscribe the socket to the new list
      this.stream?.updateSymbols(activeSymbols(db));
    }
    if (symbols.length === 0) return; // not seeded yet — data jobs wait

    if (this.due('quote_ingest', 5_000, now) && !this.stream?.live) {
      await this.runJob('quote_ingest', async () => {
        const quotes = await provider.getQuotes(activeSymbols(db));
        if (quotes.length > 0) ingestTick(db, quotes, now);
        return { quotes: quotes.length };
      });
    }
    if (this.due('bar_backfill', 600_000, now)) {
      await this.runJob('bar_backfill', () => refreshBars(db, provider, activeSymbols(db), 730));
    }

    /* ---------- trading ---------- */
    if (this.due('order_processing', 15_000, now)) {
      await this.runJob('order_processing', () => processOrders(db, provider, config, now));
    }
    if (this.due('position_monitor', 10_000, now)) {
      await this.runJob('position_monitor', () => monitorPositions(db, provider, config, now));
    }
    if (this.due('snapshot', 60_000, now)) {
      await this.runJob('snapshot', () => snapshotEquity(db, config, now));
    }
    if (this.due('signal_scan', config.scanIntervalSec * 1000, now)) {
      await this.runJob('signal_scan', () => runCryptoScan({ db, provider, config, now, tape: this.tape }));
    }

    /* ---------- settlement + learning ---------- */
    if (this.due('settle_hourly', 3_600_000, now)) {
      await this.runJob('settle_hourly', () => settleEndOfDay(db, config, etDate(now)));
    }
    if (this.due('knowledge', 1_800_000, now)) {
      await this.runJob('knowledge', () => {
        // feed back on recent closes ONCE each (marked in audit_log), then
        // refit weights/thresholds from this book's own outcomes
        const fresh = db
          .prepare(`SELECT id FROM paper_trades WHERE status = 'CLOSED' AND exit_ts >= ? ORDER BY id DESC LIMIT 50`)
          .all(now - 24 * 3_600_000) as unknown as Array<{ id: number }>;
        let recorded = 0;
        for (const t of fresh) {
          const done = db
            .prepare(`SELECT 1 FROM audit_log WHERE action = 'crypto_outcome' AND entity_id = ? LIMIT 1`)
            .get(String(t.id));
          if (done) continue;
          learnFromOutcome(db, t.id); // wins included — the positive half
          db.prepare('INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?,?,?,?,?)')
            .run(Date.now(), 'crypto_outcome', 'trade', String(t.id), JSON.stringify({ strategy: CRYPTO_STRATEGY }));
          recorded += 1;
        }
        const refit = refreshKnowledge(db);
        return { recorded, refit };
      });
    }
  }

  start(): void {
    if (this.timer) return;
    ensureSpotPortfolio(this.db, this.config);
    this.stream?.start();
    void this.runCycle();
    this.timer = setInterval(() => { void this.runCycle(); }, this.cycleMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.stream?.stop();
    this.running = false;
  }
}
