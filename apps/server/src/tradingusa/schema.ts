/**
 * TradingUSA storage — a SEPARATE SQLite database file so the existing
 * Governance DB (promptpolice.db) is never touched. All DDL is
 * CREATE TABLE IF NOT EXISTS / idempotent migrations.
 *
 * Immutability: `signals` rows are frozen by a BEFORE UPDATE trigger —
 * lifecycle status lives in `signal_status`, so a prediction can never be
 * rewritten after the outcome is known.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DDL = `
CREATE TABLE IF NOT EXISTS market_sessions (
  date TEXT PRIMARY KEY, open_ms INTEGER, close_ms INTEGER,
  early INTEGER NOT NULL DEFAULT 0, kind TEXT
);
CREATE TABLE IF NOT EXISTS market_bars (
  ticker TEXT NOT NULL, date TEXT NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
  close REAL NOT NULL, volume REAL NOT NULL,
  provider TEXT NOT NULL DEFAULT 'yahoo', fetched_at INTEGER NOT NULL,
  PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_bars_date ON market_bars(date);
CREATE TABLE IF NOT EXISTS market_quotes (
  symbol TEXT PRIMARY KEY, price REAL, prev_close REAL, ts INTEGER,
  bid REAL, ask REAL, volume REAL,
  provider TEXT NOT NULL, freshness TEXT NOT NULL DEFAULT 'DELAYED'
);
CREATE TABLE IF NOT EXISTS market_features (
  ticker TEXT NOT NULL, date TEXT NOT NULL, features_json TEXT NOT NULL,
  computed_at INTEGER NOT NULL, PRIMARY KEY (ticker, date)
);
CREATE TABLE IF NOT EXISTS fundamentals (
  ticker TEXT PRIMARY KEY, as_of TEXT, source TEXT,
  data_json TEXT, fetched_at INTEGER
);
CREATE TABLE IF NOT EXISTS economic_data (
  series TEXT NOT NULL, date TEXT NOT NULL, value REAL,
  source TEXT, PRIMARY KEY (series, date)
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL,
  url TEXT NOT NULL, category TEXT NOT NULL, retrieval_method TEXT,
  robots_ok INTEGER NOT NULL DEFAULT 1, policy_status TEXT NOT NULL DEFAULT 'ROBOTS_OK',
  reliability REAL NOT NULL DEFAULT 0.5, freshness_score REAL NOT NULL DEFAULT 0.5,
  latency_ms INTEGER NOT NULL DEFAULT 0, failure_rate REAL NOT NULL DEFAULT 0,
  duplicate_rate REAL NOT NULL DEFAULT 0, predictive_contribution REAL NOT NULL DEFAULT 0,
  documents INTEGER NOT NULL DEFAULT 0, last_checked INTEGER, check_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0, UNIQUE (domain, category)
);
CREATE TABLE IF NOT EXISTS source_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER, url TEXT NOT NULL,
  title TEXT, content TEXT, content_hash TEXT NOT NULL UNIQUE, doc_type TEXT,
  fetched_at INTEGER NOT NULL, tickers_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT, type TEXT NOT NULL,
  headline TEXT NOT NULL, materiality REAL NOT NULL, sentiment REAL NOT NULL,
  confidence REAL NOT NULL, first_seen INTEGER NOT NULL, last_updated INTEGER NOT NULL,
  sources INTEGER NOT NULL DEFAULT 1, independent_sources INTEGER NOT NULL DEFAULT 1,
  expected_horizon TEXT, dedup_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_ticker ON events(ticker, first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_events_seen ON events(first_seen DESC);
CREATE TABLE IF NOT EXISTS event_sources (
  event_id INTEGER NOT NULL REFERENCES events(id), doc_id INTEGER,
  url TEXT NOT NULL, domain TEXT, headline TEXT, seen_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, url)
);
CREATE TABLE IF NOT EXISTS market_regimes (
  date TEXT PRIMARY KEY, regime TEXT NOT NULL, confidence REAL NOT NULL,
  components_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL, company TEXT NOT NULL, sector TEXT NOT NULL,
  portfolio TEXT NOT NULL, strategy TEXT NOT NULL, strategy_version TEXT NOT NULL,
  model_version TEXT NOT NULL, horizon TEXT NOT NULL, signal TEXT NOT NULL,
  confidence REAL NOT NULL, price REAL NOT NULL,
  entry_low REAL NOT NULL, entry_high REAL NOT NULL, target REAL NOT NULL,
  invalidation REAL NOT NULL, expected_return REAL NOT NULL, risk_reward REAL NOT NULL,
  expected_hold INTEGER NOT NULL, max_hold INTEGER NOT NULL,
  session TEXT NOT NULL, session_date TEXT NOT NULL, created_at INTEGER NOT NULL,
  regime TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]',
  contradictions_json TEXT NOT NULL DEFAULT '[]', scores_json TEXT NOT NULL DEFAULT '{}',
  data_freshness REAL NOT NULL DEFAULT 1, risk_checks_json TEXT NOT NULL DEFAULT '[]',
  audit_json TEXT NOT NULL DEFAULT '{}', knowledge_refs_json TEXT NOT NULL DEFAULT '[]',
  event_refs_json TEXT NOT NULL DEFAULT '[]', llm_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker, created_at DESC);
CREATE TRIGGER IF NOT EXISTS signals_immutable BEFORE UPDATE ON signals
BEGIN SELECT RAISE(ABORT, 'signal records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS signals_nodelete BEFORE DELETE ON signals
BEGIN SELECT RAISE(ABORT, 'signal records are immutable'); END;
CREATE TABLE IF NOT EXISTS signal_status (
  signal_id INTEGER PRIMARY KEY REFERENCES signals(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE', updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_portfolios (
  kind TEXT PRIMARY KEY, start_capital REAL NOT NULL, cash REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paper_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, portfolio TEXT NOT NULL,
  signal_id INTEGER, ticker TEXT NOT NULL, side TEXT NOT NULL, qty INTEGER NOT NULL,
  limit_price REAL, stop_price REAL, status TEXT NOT NULL,
  fill_mode TEXT NOT NULL, created_at INTEGER NOT NULL, filled_at INTEGER,
  fill_price REAL, fill_note TEXT, slippage REAL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON paper_orders(status, created_at DESC);
CREATE TABLE IF NOT EXISTS paper_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, portfolio TEXT NOT NULL,
  ticker TEXT NOT NULL, company TEXT NOT NULL, sector TEXT NOT NULL,
  qty INTEGER NOT NULL, entry_price REAL NOT NULL, entry_ts INTEGER NOT NULL,
  entry_session TEXT NOT NULL, target REAL NOT NULL, stop REAL NOT NULL,
  trailing_stop REAL, max_hold INTEGER NOT NULL, sessions_held INTEGER NOT NULL DEFAULT 0,
  mfe REAL NOT NULL DEFAULT 0, mae REAL NOT NULL DEFAULT 0,
  thesis_status TEXT NOT NULL DEFAULT 'INTACT', signal_id INTEGER,
  current_price REAL, last_update INTEGER, predicted_return REAL NOT NULL DEFAULT 0,
  exit_ts INTEGER, exit_reason TEXT, UNIQUE (portfolio, ticker, exit_ts)
);
CREATE INDEX IF NOT EXISTS idx_positions_live ON paper_positions(portfolio, exit_ts);
CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, portfolio TEXT NOT NULL,
  ticker TEXT NOT NULL, company TEXT NOT NULL, sector TEXT NOT NULL, side TEXT NOT NULL,
  qty INTEGER NOT NULL, entry_price REAL NOT NULL, entry_ts INTEGER NOT NULL,
  exit_price REAL, exit_ts INTEGER, exit_reason TEXT, capital REAL NOT NULL,
  gross_pnl REAL NOT NULL DEFAULT 0, net_pnl REAL NOT NULL DEFAULT 0,
  return_pct REAL, benchmark_return REAL, excess_return REAL,
  holding_sessions INTEGER, mfe REAL, mae REAL, predicted_return REAL,
  actual_return REAL, prediction_error REAL, signal_id INTEGER,
  strategy TEXT, strategy_version TEXT, status TEXT NOT NULL DEFAULT 'CLOSED'
);
CREATE INDEX IF NOT EXISTS idx_trades_portfolio ON paper_trades(portfolio, exit_ts DESC);
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, portfolio TEXT NOT NULL, ts INTEGER NOT NULL,
  equity REAL NOT NULL, cash REAL NOT NULL, realized REAL NOT NULL,
  unrealized REAL NOT NULL, exposure REAL NOT NULL, benchmark_equity REAL
);
CREATE INDEX IF NOT EXISTS idx_snapshots ON portfolio_snapshots(portfolio, ts DESC);
CREATE TABLE IF NOT EXISTS strategy_versions (
  strategy TEXT NOT NULL, version TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  champion INTEGER NOT NULL DEFAULT 0, horizon TEXT, config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, notes TEXT, PRIMARY KEY (strategy, version)
);
CREATE TABLE IF NOT EXISTS strategy_weights (
  strategy TEXT NOT NULL, horizon TEXT NOT NULL, weights_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (strategy, horizon)
);
CREATE TABLE IF NOT EXISTS strategy_performance (
  strategy TEXT NOT NULL, period TEXT NOT NULL, trades INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0, return_pct REAL, benchmark_pct REAL,
  excess_pct REAL, updated_at INTEGER NOT NULL, PRIMARY KEY (strategy, period)
);
CREATE TABLE IF NOT EXISTS challengers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_strategy TEXT,
  status TEXT NOT NULL, observations INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mistakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER, ticker TEXT,
  kind TEXT NOT NULL, confidence REAL NOT NULL, rationale TEXT,
  ts INTEGER NOT NULL, loss_pct REAL, status TEXT NOT NULL DEFAULT 'OPEN',
  context_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS mistake_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL UNIQUE, count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0, lesson TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, statement TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5, scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'CANDIDATE', validations INTEGER NOT NULL DEFAULT 0,
  contradictions INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS candidate_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, condition_json TEXT NOT NULL,
  action TEXT NOT NULL, evidence_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'CANDIDATE', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, strategy TEXT NOT NULL, start_date TEXT NOT NULL,
  end_date TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT, created_at INTEGER NOT NULL, finished_at INTEGER, violations INTEGER
);
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, task TEXT NOT NULL,
  prompt_version TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, cached INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
  value_score REAL, invoked INTEGER NOT NULL DEFAULT 1, detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_llm_day ON llm_usage(day, provider);
CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
  prompt_version TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS llm_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, task TEXT NOT NULL,
  event_id INTEGER, signal_id INTEGER, base_action TEXT, augmented_action TEXT,
  base_conf REAL, augmented_conf REAL, outcome TEXT NOT NULL DEFAULT 'PENDING',
  actual_return REAL, tokens INTEGER NOT NULL DEFAULT 0, provider TEXT
);
CREATE TABLE IF NOT EXISTS prediction_results (
  signal_id INTEGER PRIMARY KEY, predicted_return REAL, actual_return REAL,
  prediction_error REAL, holding_error REAL, benchmark_return REAL, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS system_jobs (
  name TEXT PRIMARY KEY, schedule TEXT, last_run INTEGER, last_status TEXT,
  duration_ms INTEGER, last_error TEXT, runs INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS daily_reviews (
  date TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS weekly_reviews (
  label TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS data_quality (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  ticker TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS tu_config (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS earnings_calendar (
  ticker TEXT PRIMARY KEY, next_earnings_date TEXT NOT NULL, fetched_at INTEGER NOT NULL
);
`;

export function openTradingDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(DDL);
  return db;
}

export const TRADING_TABLES = [
  'market_sessions','market_bars','market_quotes','market_features','fundamentals',
  'economic_data','sources','source_documents','events','event_sources','market_regimes',
  'signals','signal_status','paper_portfolios','paper_orders','paper_positions',
  'paper_trades','portfolio_snapshots','strategy_versions','strategy_weights',
  'strategy_performance','challengers','mistakes','mistake_clusters','knowledge_lessons',
  'learning_events','candidate_rules','backtest_runs','llm_usage','llm_cache',
  'llm_evaluations','prediction_results','audit_log','system_jobs','daily_reviews',
  'weekly_reviews','data_quality','tu_config','earnings_calendar',
] as const;
