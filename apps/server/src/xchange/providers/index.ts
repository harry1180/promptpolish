/**
 * Provider registry — the single place a live venue is wired in.
 *
 * Adding a venue later is ONE entry here plus its adapter file: no changes to
 * the manager, the store, the feature engine or the routes.
 *
 * Current status (evidence-driven selection, docs/XCHANGE.md):
 *   kraken     production execution feed (owned by crypto/stream.ts, not here)
 *   coinbase   live, research-only — the first additional source
 *   others     NOT wired: a venue joins this map only after it demonstrates
 *              reproducible incremental value over Kraken + Coinbase.
 */
import type { ExchangeAdapter } from '../types.ts';
import type { VenueFeedConfig } from '../ws.ts';
import { createCoinbaseFeed } from './coinbase.ts';

export type ProviderFactory = (cfg: VenueFeedConfig) => ExchangeAdapter;

/** Venues this build can start. Order = display order. */
export const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  coinbase: (cfg) => createCoinbaseFeed(cfg),
};

/** Candidates deliberately not wired yet (documented, never silently enabled). */
export const PENDING_PROVIDERS = ['binanceus', 'gemini', 'bitstamp', 'cryptocom'] as const;

export const ACTIVE_PROVIDER_IDS = Object.keys(PROVIDER_FACTORIES);