import { describe, expect, it } from 'vitest';
import type { UsageEventRow } from '@promptslim/shared-types';
import {
  buildAggregate,
  eventMatchesFilters,
  filterEvents,
  groupBuckets,
  rollup,
  tagFacets,
  UNTAGGED,
  validateFilters,
  validateTags,
} from '../src/index';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1); // fixed base so series math is deterministic

let id = 0;
function ev(over: Partial<UsageEventRow>): UsageEventRow {
  id += 1;
  return {
    id,
    userId: 1,
    ts: T0,
    modelId: 'gpt-5.4',
    level: 'balanced',
    originalTokens: 1000,
    optimizedTokens: 700,
    fromCache: false,
    costOriginalUsd: 0.01,
    costOptimizedUsd: 0.007,
    tags: {},
    ...over,
  };
}

/* ---------------- tags validation ---------------- */

describe('validateTags', () => {
  it('accepts clean key/value pairs and trims whitespace', () => {
    const r = validateTags({ ' cost_center ': ' 10 ', team: 'payments' });
    expect(r.errors).toEqual([]);
    expect(r.tags).toEqual({ cost_center: '10', team: 'payments' });
  });

  it('rejects bad keys, empty values, duplicate case-insensitive keys', () => {
    const r = validateTags({ '1bad': 'x', ok: '', OK: 'y' });
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('skips fully blank rows (UI empty inputs) without errors', () => {
    const r = validateTags({ '': '' });
    expect(r.errors).toEqual([]);
    expect(r.tags).toEqual({});
  });

  it('rejects non-object input', () => {
    expect(validateTags('nope').errors.length).toBe(1);
  });
});

/* ---------------- filter semantics (the requirement) ---------------- */

describe('tag-combination filters', () => {
  const events = [
    ev({ userId: 1, tags: { cost_center: '10', team: 'payments', env: 'prod' } }),
    ev({ userId: 2, tags: { cost_center: '10', team: 'search', env: 'dev' } }),
    ev({ userId: 3, tags: { cost_center: '20', team: 'payments' } }),
    ev({ userId: 4, tags: { cost_center: '20', team: 'search' } }),
    ev({ userId: 5, tags: {} }),
  ];

  it('single filter selects every user carrying that tag (the 5-users-cost-center-10 case)', () => {
    const cc10 = [...events.slice(0, 2), ev({ userId: 6, tags: { cost_center: '10' } })];
    const hit = filterEvents(cc10, [{ key: 'cost_center', value: '10' }]);
    expect(hit.length).toBe(3);
    expect(hit.every((e) => e.tags.cost_center === '10')).toBe(true);
  });

  it('combined filters AND together', () => {
    const hit = filterEvents(events, [
      { key: 'cost_center', value: '10' },
      { key: 'team', value: 'payments' },
    ]);
    expect(hit.map((e) => e.userId)).toEqual([1]);
  });

  it('key matching is case-insensitive, value matching is exact', () => {
    expect(eventMatchesFilters(events[0]!, [{ key: 'Cost_Center', value: '10' }])).toBe(true);
    expect(eventMatchesFilters(events[0]!, [{ key: 'cost_center', value: 'ten' }])).toBe(false);
  });

  it('missing key fails the filter (no implicit wildcard)', () => {
    expect(eventMatchesFilters(events[4]!, [{ key: 'cost_center', value: '10' }])).toBe(false);
  });

  it('time window applies on top of tag filters', () => {
    const timed = [ev({ ts: T0 }), ev({ ts: T0 + 5 * DAY }), ev({ ts: T0 + 40 * DAY, tags: { cost_center: '10' } })];
    const hit = filterEvents(timed, [{ key: 'cost_center', value: '10' }], T0, T0 + 30 * DAY);
    expect(hit.length).toBe(0);
    const later = filterEvents(timed, [], T0 + 30 * DAY);
    expect(later.length).toBe(1);
  });

  it('validateFilters rejects junk', () => {
    expect(validateFilters('x').errors.length).toBe(1);
    expect(validateFilters([{ key: 'a', value: '' }]).errors.length).toBe(1);
    expect(validateFilters(undefined).filters).toEqual([]);
  });
});

/* ---------------- rollups & grouping ---------------- */

describe('rollup', () => {
  it('sums tokens, dedupes users, derives savings & reduction %', () => {
    const t = rollup([
      ev({ userId: 1, originalTokens: 1000, optimizedTokens: 600, costOriginalUsd: 0.10, costOptimizedUsd: 0.06 }),
      ev({ userId: 1, originalTokens: 500, optimizedTokens: 400, costOriginalUsd: 0.05, costOptimizedUsd: 0.04 }),
      ev({ userId: 2, originalTokens: 500, optimizedTokens: 500, costOriginalUsd: 0.05, costOptimizedUsd: 0.05 }),
    ]);
    expect(t).toMatchObject({ requests: 3, users: 2, originalTokens: 2000, optimizedTokens: 1500, savedTokens: 500 });
    expect(t.savingsUsd).toBeCloseTo(0.05, 10);
    expect(t.reductionPercent).toBeCloseTo(25, 10);
  });

  it('empty input is zero-safe', () => {
    expect(rollup([]).requests).toBe(0);
    expect(rollup([]).reductionPercent).toBe(0);
  });
});

describe('groupBuckets', () => {
  const events = [
    ev({ userId: 1, tags: { cost_center: '10' }, ts: T0 }),
    ev({ userId: 2, tags: { cost_center: '10' }, ts: T0 + DAY, originalTokens: 2000, optimizedTokens: 1000, costOriginalUsd: 0.2, costOptimizedUsd: 0.1 }),
    ev({ userId: 3, tags: { cost_center: '20' }, ts: T0 + DAY }),
    ev({ userId: 4, tags: { team: 'x' }, ts: T0 + DAY }),
  ];

  it('groups by one key and sorts buckets by money saved', () => {
    const b = groupBuckets(events, ['cost_center']);
    expect(b.map((x) => x.label)).toEqual(['10', '20', UNTAGGED]);
    expect(b[0]!.requests).toBe(2);
    expect(b[0]!.savingsUsd).toBeCloseTo(0.103, 10);
  });

  it('multi-key grouping produces composite labels', () => {
    const b = groupBuckets(events, ['cost_center', 'team']);
    expect(b.some((x) => x.label === '10 / (untagged)')).toBe(true);
    const sum = b.reduce((s, x) => s + x.requests, 0);
    expect(sum).toBe(events.length); // totals reconcile
  });
});

/* ---------------- the /api/aggregate contract ---------------- */

describe('buildAggregate', () => {
  const events = [
    ev({ userId: 1, tags: { cost_center: '10' }, ts: T0, originalTokens: 1000, optimizedTokens: 800, costOriginalUsd: 0.02, costOptimizedUsd: 0.016 }),
    ev({ userId: 2, tags: { cost_center: '10' }, ts: T0 + 9 * DAY, originalTokens: 1000, optimizedTokens: 800, costOriginalUsd: 0.02, costOptimizedUsd: 0.016 }),
  ];

  it('returns totals, buckets, series and a projection for a filtered window', () => {
    const r = buildAggregate(events, {
      filters: [{ key: 'cost_center', value: '10' }],
      groupBy: ['cost_center'],
      since: T0,
      until: T0 + 10 * DAY,
    });
    expect(r.totals.requests).toBe(2);
    expect(r.totals.users).toBe(2);
    expect(r.buckets.length).toBe(1);
    expect(r.series.length).toBe(10);
    expect(r.projectedAnnualUsd).toBeCloseTo((0.008 / 10) * 365, 6);
    expect(r.windowDays).toBe(10);
  });

  it('no events, no filters → zero totals, empty series, still valid', () => {
    const r = buildAggregate([], {});
    expect(r.totals.requests).toBe(0);
    expect(r.series).toEqual([]);
    expect(r.projectedAnnualUsd).toBe(0);
    expect(r.windowDays).toBe(1);
  });

  it('ungrouped query returns empty buckets (overall view)', () => {
    const r = buildAggregate(events, {});
    expect(r.buckets).toEqual([]);
    expect(r.totals.savingsUsd).toBeCloseTo(0.008, 10);
  });

  it('group-by user surfaces per-person savings (server injects __user tag)', () => {
    const withUser = events.map((e) => ({ ...e, tags: { ...e.tags, __user: `u${e.userId}` } }));
    const r = buildAggregate(withUser, { groupBy: ['__user'] });
    expect(r.buckets.length).toBe(2);
    expect(r.buckets.reduce((s, b) => s + b.requests, 0)).toBe(2);
  });
});

describe('tagFacets', () => {
  it('collects distinct values per key, numeric-sorted', () => {
    const f = tagFacets([
      ev({ tags: { cost_center: '2' } }),
      ev({ tags: { cost_center: '10' } }),
      ev({ tags: { team: 'search' } }),
    ]);
    expect(f).toEqual([
      { key: 'cost_center', values: ['2', '10'] },
      { key: 'team', values: ['search'] },
    ]);
  });
});
