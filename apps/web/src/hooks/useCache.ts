import { PromptCache, makeCacheStore } from '@promptslim/cache';
import type { CacheStatsSnapshot, LookupStatus } from '@promptslim/cache';

/**
 * One PromptCache per tab, persisted to localStorage. Capacity is small on
 * purpose: this is a demo-realistic working set (and keeps the per-policy
 * shadow comparison meaningful — eviction pressure is what separates the
 * policies). Phase 2 reuses the same engine with chrome.storage.local.
 */
let singleton: PromptCache | null = null;

export function getPromptCache(): PromptCache {
  if (!singleton) {
    singleton = new PromptCache({
      capacity: 12,
      store: makeCacheStore(localStorage),
    });
  }
  return singleton;
}

/** Everything the UI shows about the most recent cache interaction. */
export interface CacheOutcome {
  status: LookupStatus;
  similarity: number;
  note: string;
  served: boolean;
  entryId: string | null;
  at: number;
  partialContext?: {
    sameLevel: boolean;
    bothClean: boolean;
    neighborOutputTokens: number | null;
  };
}

export type { CacheStatsSnapshot };
