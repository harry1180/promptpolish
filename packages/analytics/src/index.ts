import type {
  AggregateRequest,
  AggregateResponse,
  RollupBucket,
  RollupTotals,
  SeriesPoint,
  TagFilter,
  TagMap,
  UsageEventRow,
} from '@promptslim/shared-types';

/**
 * Pure, DOM-free aggregation over usage events. The server runs this to
 * answer dashboard queries; the web app can re-run it on cached rows for
 * instant client-side refiltering. Tag filters AND together, so ANY
 * combination of tag key/values (cost_center=10 AND team=payments) resolves
 * to the same rollup path.
 */

/* ---------------- tag validation (signup + PUT /api/me/tags) ------------- */

export const TAG_KEY_MAX = 40;
export const TAG_VALUE_MAX = 80;
export const TAGS_MAX = 20;
const TAG_KEY_RE = /^[a-z][a-z0-9_.-]*$/i;

export interface TagValidation {
  tags: TagMap;
  errors: string[];
}

/** Normalize + validate raw signup/profile tag input. Keys are trimmed;
 *  lowercase-insensitive duplicates are rejected, not silently merged. */
export function validateTags(raw: unknown): TagValidation {
  const errors: string[] = [];
  const tags: TagMap = {};
  if (raw === undefined || raw === null || raw === '') return { tags, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { tags, errors: ['tags must be an object of key/value strings'] };
  }
  const seenKeys = new Set<string>();
  for (const [k0, v0] of Object.entries(raw as Record<string, unknown>)) {
    const k = k0.trim();
    const v = typeof v0 === 'string' ? v0.trim() : '';
    if (k === '' && v === '') continue; // blank row from the UI form
    if (seenKeys.has(k.toLowerCase())) {
      errors.push(`duplicate tag key "${k}"`);
      continue;
    }
    seenKeys.add(k.toLowerCase());
    if (k === '') errors.push('tag key required for value "' + v + '"');
    else if (!TAG_KEY_RE.test(k)) errors.push(`tag key "${k}" must start with a letter (letters, numbers, _ . -)`);
    else if (k.length > TAG_KEY_MAX) errors.push(`tag key "${k.slice(0, 16)}…" exceeds ${TAG_KEY_MAX} chars`);
    if (v === '') errors.push(`tag "${k}" has an empty value`);
    else if (v.length > TAG_VALUE_MAX) errors.push(`tag value for "${k}" exceeds ${TAG_VALUE_MAX} chars`);
    if (typeof v0 !== 'string' && v0 !== undefined && v0 !== null && v0 !== '') {
      errors.push(`tag "${k}" value must be a string`);
    }
    if (k !== '' && v !== '') tags[k] = v;
  }
  if (Object.keys(tags).length > TAGS_MAX) errors.push(`at most ${TAGS_MAX} tags per account`);
  return { tags, errors };
}

export function validateFilters(raw: unknown): { filters: TagFilter[]; errors: string[] } {
  const errors: string[] = [];
  const filters: TagFilter[] = [];
  if (raw === undefined || raw === null) return { filters, errors };
  if (!Array.isArray(raw)) return { filters, errors: ['filters must be an array'] };
  for (const f of raw as Array<Partial<TagFilter>>) {
    const key = typeof f?.key === 'string' ? f.key.trim() : '';
    const value = typeof f?.value === 'string' ? f.value.trim() : '';
    if (!key || !value) {
      errors.push('each filter needs a non-empty key and value');
      continue;
    }
    filters.push({ key, value });
  }
  if (filters.length > 10) errors.push('at most 10 filters per query');
  return { filters, errors };
}

/* ---------------- filtering ---------------------------------------------- */

/** Case-insensitive tag lookup — "Cost Center" in filters matches the
 *  stored key "cost center"; values match exactly (trimmed). */
export function eventMatchesFilters(ev: UsageEventRow, filters: TagFilter[]): boolean {
  outer: for (const f of filters) {
    const wantKey = f.key.trim().toLowerCase();
    const wantVal = f.value.trim();
    for (const [k, v] of Object.entries(ev.tags)) {
      if (k.toLowerCase() === wantKey) {
        if (v === wantVal) continue outer;
        return false;
      }
    }
    return false; // key absent entirely
  }
  return true;
}

export function filterEvents(
  events: UsageEventRow[],
  filters: TagFilter[],
  since?: number | null,
  until?: number | null,
): UsageEventRow[] {
  return events.filter(
    (e) =>
      (since == null || e.ts >= since) &&
      (until == null || e.ts <= until) &&
      eventMatchesFilters(e, filters),
  );
}

/* ---------------- rollups -------------------------------------------------- */

export const emptyTotals = (): RollupTotals => ({
  requests: 0,
  users: 0,
  originalTokens: 0,
  optimizedTokens: 0,
  savedTokens: 0,
  costOriginalUsd: 0,
  costOptimizedUsd: 0,
  savingsUsd: 0,
  reductionPercent: 0,
  chatRequests: 0,
  actualCostUsd: 0,
});

export function rollup(events: UsageEventRow[]): RollupTotals {
  const t = emptyTotals();
  const users = new Set<number>();
  for (const e of events) {
    t.requests += 1;
    users.add(e.userId);
    t.originalTokens += e.originalTokens;
    t.optimizedTokens += e.optimizedTokens;
    t.costOriginalUsd += e.costOriginalUsd;
    t.costOptimizedUsd += e.costOptimizedUsd;
    if (e.source === 'chat') {
      t.chatRequests += 1;
      t.actualCostUsd += e.actualCostUsd ?? 0;
    }
  }
  t.users = users.size;
  t.savedTokens = Math.max(0, t.originalTokens - t.optimizedTokens);
  t.savingsUsd = Math.max(0, t.costOriginalUsd - t.costOptimizedUsd);
  t.reductionPercent = t.originalTokens > 0 ? (t.savedTokens / t.originalTokens) * 100 : 0;
  return t;
}

export const UNTAGGED = '(untagged)';

function finishBucket(label: string, values: string[] | null, events: UsageEventRow[]): RollupBucket {
  return { label, values, ...rollup(events) };
}

/**
 * Group events by one or more tag keys (the executive "breakdown" view:
 * cost center, team, env, …). Events missing a group key land in the
 * `(untagged)` bucket so totals always reconcile. Buckets sort by savings
 * (money leads), then requests.
 */
export function groupBuckets(events: UsageEventRow[], groupBy: string[]): RollupBucket[] {
  if (groupBy.length === 0) return [];
  const lowered = groupBy.map((k) => k.trim().toLowerCase());
  const map = new Map<string, { values: string[]; events: UsageEventRow[] }>();
  for (const e of events) {
    const resolved = lowered.map((k) => {
      for (const [key, v] of Object.entries(e.tags)) {
        if (key.toLowerCase() === k) return v;
      }
      return UNTAGGED;
    });
    const sig = resolved.join('\u0000');
    let slot = map.get(sig);
    if (!slot) {
      slot = { values: resolved, events: [] };
      map.set(sig, slot);
    }
    slot.events.push(e);
  }
  const buckets = [...map.values()].map((s) =>
    finishBucket(s.values.join(' / '), s.values, s.events),
  );
  buckets.sort((a, b) => b.savingsUsd - a.savingsUsd || b.requests - a.requests);
  return buckets;
}

/* ---------------- daily series ------------------------------------------- */

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Daily points across the covered range (gaps filled with zeros). */
export function dailySeries(events: UsageEventRow[]): SeriesPoint[] {
  if (events.length === 0) return [];
  const byDay = new Map<string, SeriesPoint>();
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    const d = utcDay(e.ts);
    let p = byDay.get(d);
    if (!p) {
      p = { date: d, requests: 0, savedUsd: 0, costUsd: 0 };
      byDay.set(d, p);
    }
    p.requests += 1;
    p.costUsd += e.costOptimizedUsd;
    p.savedUsd += Math.max(0, e.costOriginalUsd - e.costOptimizedUsd);
    if (e.ts < min) min = e.ts;
    if (e.ts > max) max = e.ts;
  }
  const points: SeriesPoint[] = [];
  const dayMs = 86_400_000;
  for (let t = min - (min % dayMs); t <= max; t += dayMs) {
    const d = utcDay(t);
    points.push(byDay.get(d) ?? { date: d, requests: 0, savedUsd: 0, costUsd: 0 });
  }
  return points;
}

/* ---------------- full aggregate response --------------------------------- */

const DAY_MS = 86_400_000;

/**
 * The single entry point the server exposes as POST /api/aggregate.
 * `events` should already be scoped to what the caller may see; this
 * function only filters/groups/sums.
 */
export function buildAggregate(allEvents: UsageEventRow[], req: AggregateRequest): AggregateResponse {
  const since = typeof req.since === 'number' && Number.isFinite(req.since) ? req.since : null;
  const until = typeof req.until === 'number' && Number.isFinite(req.until) ? req.until : null;
  const filters = req.filters ?? [];
  const groupBy = (req.groupBy ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 3);
  const events = filterEvents(allEvents, filters, since, until);
  const totals = rollup(events);

  const windowDays = Math.max(
    1,
    Math.ceil(((until ?? Date.now()) - (since ?? Math.min(...events.map((e) => e.ts), Infinity))) / DAY_MS) || 1,
  );
  return {
    window: { since, until },
    filters,
    groupBy,
    totals,
    projectedAnnualUsd: (totals.savingsUsd / windowDays) * 365,
    windowDays,
    buckets: groupBuckets(events, groupBy),
    series: dailySeries(events),
  };
}

/** Distinct tag key/value pairs across events — powers the filter facet UI. */
export function tagFacets(events: UsageEventRow[]): Array<{ key: string; values: string[] }> {
  const map = new Map<string, Set<string>>();
  for (const e of events) {
    for (const [k, v] of Object.entries(e.tags)) {
      const lk = k.trim().toLowerCase();
      let set = map.get(lk);
      if (!set) {
        set = new Set();
        map.set(lk, set);
      }
      set.add(v);
    }
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, values]) => ({ key, values: [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }));
}
