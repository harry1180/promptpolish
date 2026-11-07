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
import { CRYPTO_SESSION, type CryptoConfig } from './config.ts';
import { CRYPTO_BENCHMARK, CRYPTO_PORTFOLIO, loadBars, openPositions, type PositionRow } from './broker.ts';
import { CRYPTO_STRATEGY } from './engine.ts';
import type { CryptoRuntime } from './runtime.ts';
import { loadUniverseStates } from './universe.ts';
import { snapshotEquity } from './workers.ts';

export interface CryptoDeps {
  runtime: CryptoRuntime;
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

function tradeStats(db: DatabaseSync): {
  closed: number; wins: number; winRatePct: number; netPnl: number; avgReturnPct: number;
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
  return {
    closed: row.closed,
    wins: row.wins ?? 0,
    winRatePct: row.closed > 0 ? Math.round(((row.wins ?? 0) / row.closed) * 1000) / 10 : 0,
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

    return done({ status: 404, body: { error: 'unknown crypto endpoint' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'crypto route failed';
    return done({ status: 500, body: { error: message } });
  }
}