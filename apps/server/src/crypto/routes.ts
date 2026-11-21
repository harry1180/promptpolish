/**
 * Crypto HTTP surface — all GET (read-only) except POST /run (one manual
 * scheduler pass). Mounted in createApp at '/api/crypto/*', served at the edge
 * under '/pp/api/crypto/*'.
 *
 * Security rules, same as the TradingUSA surface:
 *  - never emit secret material: provider status enums only, no process.env;
 *  - executionMode is always PAPER_ONLY (from config, not a request field);
 *  - this book is read-only except the manual run trigger, which only runs
 *    the same cycle the timer would have run anyway.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { FUSION_WEIGHTS } from '@promptslim/tucore';
import { learnedWeights } from '../tradingusa/adaptive.ts';
import { experimentSummary } from '../tradingusa/experiments.ts';
import { evaluateFixedHorizons } from './accuracy.ts';
import { handleXchange } from '../xchange/routes.ts';
import { CRYPTO_SESSION, type CryptoConfig } from './config.ts';
import { k15mCounts, recentSamples, recentSignals, signalSummary, windowRows } from '../kalshi15m/store.ts';
import type { K15mRuntime } from '../kalshi15m/runtime.ts';
import type { SpotRuntime } from '../kalshi15m/spot.ts';
import { CRYPTO_BENCHMARK, CRYPTO_PORTFOLIO, loadBars, openPositions, type PositionRow } from './broker.ts';
import { CRYPTO_STRATEGY } from './engine.ts';
import type { CryptoRuntime } from './runtime.ts';
import { loadUniverseStates } from './universe.ts';
import { snapshotEquity } from './workers.ts';

export interface CryptoDeps {
  runtime: CryptoRuntime;
  /** Kalshi 15-minute engine (constructed in createApp; absent in tests) */
  k15m?: K15mRuntime | undefined;
  /** BTC spot tape (Coinbase + Kraken observer hooks) */
  spot?: SpotRuntime | undefined;
  readBody: (req: IncomingMessage) => Promise<unknown>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
}

type Res = { status: number; body: unknown };

function signalRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id, ticker: r.ticker, company: r.company, sector: r.sector, portfolio: r.portfolio,
    signal: r.signal, horizon: r.horizon, confidence: r.confidence, price: r.price,
    entryLow: r.entry_low, entryHigh: r.entry_high, target: r.target, invalidation: r.invalidation,
    expectedReturnPct: (r.expected_return as number) * 100, riskReward: r.risk_reward,
    strategy: r.strategy, createdAt: r.created_at, session: r.session, status: r.status ?? 'ACTIVE',
    regime: r.regime, dataFreshness: r.data_freshness, signalDate: r.session_date,
  };
}

function positionRow(r: PositionRow): Record<string, unknown> {
  const entry = Number(r.entry_price);
  const last = Number(r.current_price ?? entry);
  const qty = Number(r.qty);
  return {
    id: r.id, ticker: r.ticker, company: r.company, qty, entryPrice: entry,
    entryTs: r.entry_ts, entrySession: r.entry_session, currentPrice: last,
    unrealized: (last - entry) * qty,
    unrealizedPct: entry > 0 ? ((last - entry) / entry) * 100 : 0,
    stop: r.stop, target: r.target, maxHold: r.max_hold, sessionsHeld: r.sessions_held,
    mfe: r.mfe, mae: r.mae, thesisStatus: r.thesis_status, predictedReturn: r.predicted_return,
    entryFee: r.entry_fee ?? 0, signalId: r.signal_id,
  };
}

function tradeRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id, ticker: r.ticker, side: r.side, qty: r.qty,
    entryPrice: r.entry_price, entryTs: r.entry_ts, exitPrice: r.exit_price, exitTs: r.exit_ts,
    exitReason: r.exit_reason, netPnl: r.net_pnl, grossPnl: r.gross_pnl,
    returnPct: (r.return_pct as number) * 100, benchmarkReturnPct: (r.benchmark_return as number) * 100,
    excessReturnPct: (r.excess_return as number) * 100, predictedReturnPct: (r.predicted_return as number) * 100,
    predictionError: r.prediction_error, holdingSessions: r.holding_sessions,
    strategy: r.strategy, capital: r.capital, status: r.status,
  };
}

/**
 * Wilson 95% interval for a proportion — the honest way to show a win rate
 * over a handful of trades: 0 wins in 4 closes is a rate of 0% with an
 * interval of [0%, 60%], i.e. "no information yet", not a system that never
 * wins. Returns null while nothing has closed (no interval to draw).
 */
function wilson95(wins: number, n: number): { low: number; high: number } | null {
  if (n <= 0) return null;
  const z = 1.96;
  const z2 = z * z;
  const p = wins / n;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  const r = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 10;
  return { low: r(center - half), high: r(center + half) };
}

function tradeStats(db: DatabaseSync): {
  closed: number; wins: number; winRatePct: number;
  winRateCiLowPct: number | null; winRateCiHighPct: number | null;
  netPnl: number; avgReturnPct: number;
  feesPaid: number; avgHoldSessions: number;
} {
  const row = db.prepare(
    `SELECT COUNT(*) AS closed,
            SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) AS wins,
            COALESCE(SUM(net_pnl), 0) AS net,
            COALESCE(SUM(gross_pnl - net_pnl), 0) AS fees_closed,
            COALESCE(AVG(return_pct), 0) AS avg_ret,
            COALESCE(AVG(holding_sessions), 0) AS avg_hold
       FROM paper_trades WHERE status = 'CLOSED'`,
  ).get() as { closed: number; wins: number | null; net: number; fees_closed: number; avg_ret: number; avg_hold: number };
  // Cumulative fees paid to date = entry+exit fees of every closed trade
  // (net_pnl = gross - entry fee - exit fee, so gross - net IS the fee) plus
  // the entry fee already charged on positions still open. Closed position
  // rows keep their entry_fee, but those fees are counted inside gross-net of
  // their trade — summing paper_positions wholesale would double count them.
  const openFees = db
    .prepare('SELECT COALESCE(SUM(entry_fee), 0) AS f FROM paper_positions WHERE exit_ts IS NULL')
    .get() as { f: number };
  const ci = wilson95(row.wins ?? 0, row.closed);
  return {
    closed: row.closed,
    wins: row.wins ?? 0,
    winRatePct: row.closed > 0 ? Math.round(((row.wins ?? 0) / row.closed) * 1000) / 10 : 0,
    winRateCiLowPct: ci?.low ?? null,
    winRateCiHighPct: ci?.high ?? null,
    netPnl: Math.round(row.net * 100) / 100,
    avgReturnPct: Math.round(row.avg_ret * 10000) / 100,
    feesPaid: Math.round((row.fees_closed + openFees.f) * 100) / 100,
    avgHoldSessions: Math.round(row.avg_hold * 10) / 10,
  };
}

function universeView(db: DatabaseSync): {
  members: number; active: number; pinned: string[]; ranked: string[]; changes: unknown[];
} {
  const states = loadUniverseStates(db);
  const log = db.prepare('SELECT ts, action, symbol FROM crypto_universe_log ORDER BY id DESC LIMIT 20').all() as unknown as unknown[];
  return {
    members: states.length,
    active: states.filter((s) => s.active).length,
    pinned: states.filter((s) => s.pinned && s.active).map((s) => s.symbol),
    ranked: states.filter((s) => !s.pinned && s.active).map((s) => s.symbol),
    changes: log,
  };
}

export async function handleCrypto(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: CryptoDeps,
): Promise<boolean> {
  const { runtime, json } = deps;
  const db = runtime.db;
  const config: CryptoConfig = runtime.config;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = path.split('/').filter(Boolean); // ['api','crypto', ...]
  if (seg.length < 2 || seg[0] !== 'api' || seg[1] !== 'crypto') return false;
  const rest = seg.slice(2);
  const now = Date.now();

  const done = (r: Res): true => { json(res, r.status, r.body); return true; };
  const int = (v: string | null, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  const dateStr = (v: string | null, fallbackDays: number): string =>
    v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Date(now - fallbackDays * 86_400_000).toISOString().slice(0, 10);

  try {
    /* ---------------- status ---------------- */
    if (rest.length === 1 && rest[0] === 'status' && req.method === 'GET') {
      const counts = {
        quotes: (db.prepare('SELECT COUNT(*) AS n FROM market_quotes').get() as { n: number }).n,
        bars: (db.prepare('SELECT COUNT(*) AS n FROM market_bars').get() as { n: number }).n,
        signals: (db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n,
        openPositions: openPositions(db).length,
        closedTrades: (db.prepare(`SELECT COUNT(*) AS n FROM paper_trades WHERE status = 'CLOSED'`).get() as { n: number }).n,
      };
      const jobs = db
        .prepare('SELECT name, schedule, last_run, last_status, duration_ms, last_error, runs FROM system_jobs ORDER BY name')
        .all() as unknown as Array<Record<string, unknown>>;
      return done({
        status: 200,
        body: {
          ok: true,
          executionMode: config.executionMode,
          portfolioKind: config.portfolioKind,
          session: CRYPTO_SESSION,
          alwaysOpen: true,
          provider: {
            name: runtime.provider.name,
            status: runtime.provider.status(),
            lastUpdate: runtime.provider.lastUpdate(),
            lastLatencyMs: runtime.provider.lastLatencyMs(),
            lastError: runtime.provider.lastError(),
          },
          stream: { live: runtime.stream.live, symbols: runtime.stream.symbols.size },
          universe: universeView(db),
          counts,
          jobs,
          recentErrors: runtime.scheduler.errors.slice(-5),
        },
      });
    }

    /* ---------------- overview ---------------- */
    if (rest.length === 1 && rest[0] === 'overview' && req.method === 'GET') {
      const portfolio = db
        .prepare('SELECT kind, start_capital, cash, created_at FROM paper_portfolios WHERE kind = ?')
        .get(CRYPTO_PORTFOLIO) as { kind: string; start_capital: number; cash: number; created_at: number } | undefined;
      const snap = db
        .prepare('SELECT ts, equity, cash, unrealized, exposure, benchmark_equity FROM portfolio_snapshots WHERE portfolio = ? ORDER BY ts DESC LIMIT 1')
        .get(CRYPTO_PORTFOLIO) as { ts: number; equity: number; cash: number; unrealized: number; exposure: number; benchmark_equity: number } | undefined;
      const btcBars = loadBars(db, CRYPTO_BENCHMARK);
      const btcNow = btcBars[btcBars.length - 1]?.close ?? 0;
      const btcStart = Number(
        (db.prepare(`SELECT value FROM tu_config WHERE key = 'btc_start'`).get() as { value: string } | undefined)?.value ?? btcNow,
      );
      const positions = openPositions(db).map(positionRow);
      const recent = (db
        .prepare('SELECT * FROM paper_trades ORDER BY exit_ts DESC LIMIT 10')
        .all() as unknown as Array<Record<string, unknown>>).map(tradeRow);
      const stats = tradeStats(db); // feesPaid: closed-trade fees + open entry fees
      return done({
        status: 200,
        body: {
          portfolio: portfolio ? {
            kind: portfolio.kind, startCapital: portfolio.start_capital, cash: portfolio.cash,
            equity: snap?.equity ?? portfolio.cash, unrealized: snap?.unrealized ?? 0,
            exposure: snap?.exposure ?? 0,
            returnPct: snap && portfolio.start_capital > 0
              ? Math.round(((snap.equity - portfolio.start_capital) / portfolio.start_capital) * 10000) / 100 : 0,
            createdAt: portfolio.created_at,
          } : null,
          benchmark: {
            symbol: CRYPTO_BENCHMARK, price: btcNow, startPrice: btcStart,
            equity: snap?.benchmark_equity ?? config.startCapital,
            returnPct: btcStart > 0 ? Math.round(((btcNow - btcStart) / btcStart) * 10000) / 100 : 0,
          },
          stats,
          positions,
          recentTrades: recent,
          snapshotAt: snap?.ts ?? null,
        },
      });
    }

    /* ---------------- quotes ---------------- */
    if (rest.length === 1 && rest[0] === 'quotes' && req.method === 'GET') {
      const states = loadUniverseStates(db);
      const rows = db
        .prepare('SELECT symbol, price, prev_close, ts, bid, ask, provider, freshness FROM market_quotes ORDER BY symbol')
        .all() as unknown as Array<Record<string, unknown>>;
      const quotes = rows.map((r) => {
        const state = states.find((s) => s.symbol === r.symbol);
        const price = Number(r.price);
        const prev = Number(r.prev_close);
        return {
          symbol: r.symbol, price, prevClose: prev,
          changePct: prev > 0 ? Math.round(((price - prev) / prev) * 10000) / 100 : 0,
          bid: r.bid, ask: r.ask, ts: r.ts, provider: r.provider, freshness: r.freshness,
          pinned: state?.pinned ?? false, rank: state?.lastRank ?? null, active: state?.active ?? false,
        };
      });
      return done({ status: 200, body: { count: quotes.length, quotes } });
    }

    /* ---------------- universe ---------------- */
    if (rest.length === 1 && rest[0] === 'universe' && req.method === 'GET') {
      return done({ status: 200, body: universeView(db) });
    }

    /* ---------------- signals ---------------- */
    if (rest.length === 1 && rest[0] === 'signals' && req.method === 'GET') {
      const limit = int(url.searchParams.get('limit'), 50);
      const signal = url.searchParams.get('signal');
      const date = url.searchParams.get('date');
      let sql = 'SELECT * FROM signals';
      const where: string[] = [];
      const args: unknown[] = [];
      if (signal === 'BUY' || signal === 'SELL') { where.push('signal = ?'); args.push(signal); }
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) { where.push('session_date = ?'); args.push(date); }
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' ORDER BY id DESC LIMIT ?';
      args.push(limit);
      const rows = (db.prepare(sql).all(...(args as never[])) as unknown as Array<Record<string, unknown>>).map(signalRow);
      return done({ status: 200, body: { count: rows.length, signals: rows } });
    }

    /* ---------------- positions ---------------- */
    if (rest.length === 1 && rest[0] === 'positions' && req.method === 'GET') {
      const rows = openPositions(db).map(positionRow);
      return done({ status: 200, body: { count: rows.length, positions: rows } });
    }

    /* ---------------- trades ---------------- */
    if (rest.length === 1 && rest[0] === 'trades' && req.method === 'GET') {
      const limit = int(url.searchParams.get('limit'), 50);
      const rows = (db.prepare('SELECT * FROM paper_trades ORDER BY exit_ts DESC LIMIT ?').all(limit) as unknown as Array<Record<string, unknown>>).map(tradeRow);
      return done({ status: 200, body: { count: rows.length, stats: tradeStats(db), trades: rows } });
    }

    /* ---------------- microstructure (shadow) ---------------- */
    if (rest.length === 1 && rest[0] === 'micro' && req.method === 'GET') {
      const f = config.micro;
      const body = runtime.micro
        ? runtime.micro.status()
        : {
            flags: {
              enabled: f.enabled, l2Features: f.l2Features, metaLabeling: f.metaLabeling,
              costAwareValidation: f.costAwareValidation, shadowMode: f.shadowMode,
              liveExecution: f.liveExecution,
            },
            executionMode: 'PAPER_ONLY',
            decisionImpact: 'NONE (engine off: SCALPING_ALPHA_ENABLED is not 1)',
            l2: { enabled: false, reason: 'book channel not subscribed' },
            queue: null,
            features: {},
          };
      return done({ status: 200, body });
    }

    /* ---------------- fixed-horizon accuracy (correction item 2) ---------------- */
    if (rest.length === 1 && rest[0] === 'accuracy' && req.method === 'GET') {
      return done({ status: 200, body: evaluateFixedHorizons(db) });
    }

    /* ---------------- portfolio history ---------------- */
    if (rest.length === 1 && rest[0] === 'portfolio' && req.method === 'GET') {
      const rows = db
        .prepare('SELECT ts, equity, cash, unrealized, benchmark_equity FROM portfolio_snapshots WHERE portfolio = ? ORDER BY ts DESC LIMIT 500')
        .all(CRYPTO_PORTFOLIO) as unknown as Array<Record<string, unknown>>;
      return done({
        status: 200,
        body: {
          count: rows.length,
          points: rows.reverse().map((r) => ({
            ts: r.ts, equity: r.equity, cash: r.cash, unrealized: r.unrealized, benchmark: r.benchmark_equity,
          })),
        },
      });
    }

    /* ---------------- learning ---------------- */
    if (rest.length === 1 && rest[0] === 'learning' && req.method === 'GET') {
      const learned = learnedWeights(db, CRYPTO_STRATEGY, 'SHORT');
      const lessons = db
        .prepare('SELECT status, COUNT(*) AS n FROM knowledge_lessons GROUP BY status')
        .all() as unknown as Array<{ status: string; n: number }>;
      const outcomes = db
        .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'crypto_outcome'`)
        .get() as { n: number };
      const refits = db
        .prepare(`SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'WEIGHTS_REFIT'`)
        .get() as { n: number } | undefined;
      return done({
        status: 200,
        body: {
          strategy: CRYPTO_STRATEGY,
          horizon: 'SHORT',
          fusionWeights: {
            defaults: FUSION_WEIGHTS.SHORT,
            configured: config.fusionWeights,
            learned: learned.weights ?? null,
            sufficient: learned.sufficient,
            trades: learned.trades,
            updatedAt: (db.prepare('SELECT updated_at FROM strategy_weights WHERE strategy = ? AND horizon = ?')
              .get(CRYPTO_STRATEGY, 'SHORT') as { updated_at: number } | undefined)?.updated_at ?? null,
          },
          lessonsByStatus: lessons,
          outcomesRecorded: outcomes.n,
          weightRefits: refits?.n ?? 0,
          note: 'Outcomes from the crypto book refit crypto weights only (MIN_TRADES floor, ±35% bound).',
        },
      });
    }

    /* ---------------- shadow experiments ---------------- */
    if (rest.length === 1 && rest[0] === 'experiments' && req.method === 'GET') {
      const from = dateStr(url.searchParams.get('from'), 90);
      const to = url.searchParams.get('to') && /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') ?? '')
        ? (url.searchParams.get('to') as string)
        : new Date(now).toISOString().slice(0, 10);
      if (from > to) return done({ status: 400, body: { error: 'from must be before to' } });
      return done({ status: 200, body: experimentSummary(db, from, to) });
    }

    /* ---------------- top-K ranking recorder (shadow) ---------------- */
    if (rest.length === 1 && rest[0] === 'shadow' && req.method === 'GET') {
      const counts = db
        .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(selected), 0) AS sel, COALESCE(SUM(order_created), 0) AS taken FROM shadow_topk')
        .get() as { n: number; sel: number; taken: number };
      const outcomes = db
        .prepare(
          `SELECT s.selected AS selected, COUNT(*) AS n,
                  COALESCE(SUM(CASE WHEN t.net_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
                  COALESCE(SUM(t.net_pnl), 0) AS netPnl
             FROM shadow_topk s
             JOIN paper_trades t ON t.signal_id = s.signal_id AND t.status = 'CLOSED'
            GROUP BY s.selected ORDER BY s.selected`,
        )
        .all() as unknown as Array<{ selected: number; n: number; wins: number; netPnl: number }>;
      const recent = db
        .prepare('SELECT ts, session_date, signal_id, ticker, score, confidence, rank, selected, order_created FROM shadow_topk ORDER BY id DESC LIMIT 20')
        .all() as unknown as Array<Record<string, unknown>>;
      return done({
        status: 200,
        body: {
          enabled: config.topk.shadow,
          k: config.topk.k,
          mode: 'shadow',
          decisionImpact: 'NONE — every BUY still trades; this table only records what a top-K rule would have kept',
          recorded: counts.n,
          selected: counts.sel,
          takenByProduction: counts.taken,
          outcomes,
          recent,
        },
      });
    }

    /* ---------------- jobs ---------------- */
    if (rest.length === 1 && rest[0] === 'jobs' && req.method === 'GET') {
      const jobs = db.prepare('SELECT * FROM system_jobs ORDER BY last_run DESC').all() as unknown as unknown[];
      return done({ status: 200, body: { count: jobs.length, jobs } });
    }

    /* ---------------- manual cycle (POST) ---------------- */
    if (rest.length === 1 && rest[0] === 'run' && req.method === 'POST') {
      const before = (db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n;
      await runtime.scheduler.runCycle(now);
      const after = (db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n;
      return done({
        status: 200,
        body: {
          ok: true, signalsCreated: after - before, snapshot: snapshotEquity(db, config, now),
          jobs: db.prepare('SELECT name, last_status, duration_ms, last_error FROM system_jobs ORDER BY name').all(),
        },
      });
    }

    /* ---------------- Kalshi 15-minute engine (read-only) ---------------- */
    if (rest.length >= 1 && rest[0] === 'kalshi15m' && req.method === 'GET') {
      const k = deps.k15m;
      if (rest[1] === 'windows') {
        return done({ status: 200, body: { count: k15mCounts(db).windows, windows: windowRows(db, int(url.searchParams.get('limit'), 20)) } });
      }
      if (rest[1] === 'samples') {
        const market = url.searchParams.get('market') ?? k?.current?.marketTicker ?? '';
        if (!market) return done({ status: 200, body: { count: 0, samples: [] } });
        const rows = recentSamples(db, market, int(url.searchParams.get('limit'), 300));
        return done({ status: 200, body: { count: rows.length, market, samples: rows } });
      }
      if (rest[1] === 'signals') {
        if (!k) return done({ status: 200, body: { enabled: false, signals: [] } });
        const strategy = url.searchParams.get('strategy');
        const rows = recentSignals(db, int(url.searchParams.get('limit'), 200), strategy ?? undefined);
        return done({
          status: 200,
          body: {
            count: rows.length,
            mode: 'SHADOW — no order is ever placed from this engine',
            strategyAEnabled: ((k.status(now) as { strategyA?: { enabled?: boolean } }).strategyA?.enabled) ?? false,
            summary: signalSummary(db, int(url.searchParams.get('summary_limit'), 2_000)),
            signals: rows,
          },
        });
      }
      if (rest[1] === 'calibration') {
        if (!k) {
          return done({ status: 200, body: { enabled: false, note: 'K15mRuntime not constructed in this process' } });
        }
        return done({ status: 200, body: k.calibration(int(url.searchParams.get('limit'), 2_000)) });
      }
      if (rest[1] === 'spot') {
        if (!deps.spot) {
          return done({ status: 200, body: { enabled: false, note: 'SpotRuntime not constructed in this process' } });
        }
        return done({ status: 200, body: deps.spot.status(now) });
      }
      if (rest[1] === 'health') {
        const rows = db.prepare('SELECT * FROM k15m_feed_health ORDER BY id DESC LIMIT ?')
          .all(int(url.searchParams.get('limit'), 20)) as unknown as unknown[];
        return done({ status: 200, body: { count: rows.length, health: rows } });
      }
      // default: live status (window, book, feed counters) — never secrets
      if (k) return done({ status: 200, body: k.status(now) });
      let counts: Record<string, number> = {};
      try { counts = k15mCounts(db); } catch { counts = {}; } // tables may not exist
      return done({ status: 200, body: { enabled: false, note: 'K15mRuntime not constructed in this process', counts } });
    }

    /* ---------------- multi-exchange market intelligence ---------------- */
    if (rest.length >= 1 && ['providers', 'xchange', 'sources', 'context'].includes(rest[0])) {
      return await handleXchange(req, res, rest, { runtime, json });
    }

    return done({ status: 404, body: { error: 'unknown crypto endpoint' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'crypto route failed';
    return done({ status: 500, body: { error: message } });
  }
}