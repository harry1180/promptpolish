import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AggregateResponse, TagFilter, TagMap } from '@promptslim/shared-types';
import { formatNumber, formatPercent, formatUSD } from '@promptslim/pricing-engine';
import { api } from '../api/account';

/* Executive dashboard: answers "how much is prompt optimization saving the
 * organization, for which cost centers, and is the trend going the right way"
 * — in dollars first, tokens second. Filters combine any tag key/values with
 * AND semantics; the breakdown groups by any one tag (or by user). */

const WINDOWS = [
  { id: '7', label: '7 days', days: 7 },
  { id: '30', label: '30 days', days: 30 },
  { id: '90', label: '90 days', days: 90 },
  { id: 'all', label: 'All time', days: null },
] as const;

function KpiCard({ label, value, sub, tone = 'mint' }: {
  label: string; value: string; sub?: string; tone?: 'mint' | 'plain' | 'violet';
}) {
  const toneCls = tone === 'mint' ? 'text-mint' : tone === 'violet' ? 'text-violet-soft' : 'text-slate-soft';
  return (
    <div className="card p-4" aria-label={label}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">{label}</div>
      <div className={`mt-1.5 font-mono text-2xl font-bold leading-none ${toneCls}`}>{value}</div>
      {sub && <div className="mt-1.5 text-[11px] text-mist">{sub}</div>}
    </div>
  );
}

/** Minimal inline SVG column chart — no chart library, execs just need direction. */
function TrendChart({ data }: { data: AggregateResponse['series'] }) {
  if (data.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-mist">No activity in this window yet.</div>;
  }
  const max = Math.max(...data.map((d) => d.savedUsd), 1e-9);
  const w = 100 / data.length;
  return (
    <div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label="Daily savings trend">
        {data.map((d, i) => {
          const h = Math.max((d.savedUsd / max) * 34, d.savedUsd > 0 ? 1.5 : 0.4);
          return (
            <rect key={d.date} x={i * w + w * 0.18} y={38 - h} width={w * 0.64} height={h}
              rx={0.8} fill="var(--color-mint)" opacity={0.28 + 0.7 * (d.savedUsd / max)} >
              <title>{`${d.date} · ${formatUSD(d.savedUsd)} saved · ${d.requests} runs`}</title>
            </rect>
          );
        })}
        <line x1="0" y1="38" x2="100" y2="38" stroke="var(--color-line)" strokeWidth="0.4" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-mist">
        <span>{data[0]?.date}</span>
        <span>peak {formatUSD(max)}/day</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

interface Facet {
  key: string;
  values: Array<{ value: string; events: number }>;
}

export function DashboardPanel({ accountTags }: { accountTags: TagMap }) {
  const [winId, setWinId] = useState<string>('30');
  const [filters, setFilters] = useState<TagFilter[]>([]);
  const [groupBy, setGroupBy] = useState<string>('cost_center');
  const [agg, setAgg] = useState<AggregateResponse | null>(null);
  const [facets, setFacets] = useState<Facet[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const days = WINDOWS.find((w) => w.id === winId)?.days ?? null;

  useEffect(() => {
    let alive = true;
    void api.facets().then((r) => { if (alive && r.ok && r.data) setFacets(r.data.facets); });
    return () => { alive = false; };
  }, [agg === null]);

  const refresh = useCallback(() => {
    setState('loading');
    const since = days == null ? null : Date.now() - days * 86_400_000;
    void api.aggregate({ filters, groupBy: groupBy ? [groupBy] : [], since, until: null })
      .then((r) => {
        if (r.ok && r.data) {
          setAgg(r.data);
          setState('ready');
        } else {
          setError(r.errors.join(' · ') || 'query failed');
          setState('error');
        }
      });
  }, [filters, groupBy, days]);

  useEffect(refresh, [refresh]);

  const addFilter = (key: string, value: string) => {
    if (filters.some((f) => f.key.toLowerCase() === key.toLowerCase() && f.value === value)) return;
    setFilters([...filters, { key, value }]);
  };

  const facetKeys = useMemo(() => {
    const set = new Map<string, string>();
    for (const f of facets) set.set(f.key, f.key);
    return [...set.keys()];
  }, [facets]);

  const totals = agg?.totals;
  const bucketCols = agg && agg.buckets.length > 0;

  return (
    <section className="card p-5 md:p-6" id="dashboard" aria-label="Executive dashboard">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Executive dashboard</h2>
          <p className="text-xs text-mist">
            Org-wide spend impact of prompt optimization · your account tags:{' '}
            {Object.keys(accountTags).length
              ? <span className="font-mono text-violet-soft">{Object.entries(accountTags).map(([k, v]) => `${k}=${v}`).join('  ')}</span>
              : <span className="italic">none — add them in Sign in → tags later</span>}
          </p>
        </div>
        <div className="ml-auto flex gap-1 rounded-lg border border-line bg-ink-800 p-1" role="group" aria-label="Time range">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              onClick={() => setWinId(w.id)}
              aria-pressed={winId === w.id}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                winId === w.id ? 'bg-mint/15 text-mint' : 'text-mist hover:text-slate-soft'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* tag-combination filters */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">Filter by tags</span>
        {filters.map((f) => (
          <button
            key={`${f.key}|${f.value}`}
            onClick={() => setFilters(filters.filter((x) => x !== f))}
            className="rounded-full border border-violet-soft/40 bg-violet-soft/10 px-2.5 py-0.5 font-mono text-xs text-violet-soft transition-colors hover:border-danger/60 hover:text-danger"
            title="Remove filter"
          >
            {f.key}={f.value} ✕
          </button>
        ))}
        <FilterPicker facets={facets} onPick={addFilter} disabled={facetKeys.length === 0} />
        {facetKeys.length === 0 && (
          <span className="text-xs text-mist">No tags recorded yet — they appear once teammates sign up and run prompts.</span>
        )}
        {filters.length > 1 && <span className="text-[11px] text-mist">all filters must match (AND)</span>}
      </div>

      {state === 'error' && (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </div>
      )}

      {state === 'loading' && !agg && (
        <div className="flex h-56 items-center justify-center text-sm text-mist">Crunching org numbers…</div>
      )}

      {agg && (
        <>
          {/* KPI row — money first */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <KpiCard
              label="Savings · this window"
              value={formatUSD(agg.totals.savingsUsd)}
              sub={`across ${agg.totals.users} user${agg.totals.users === 1 ? '' : 's'} · ${formatNumber(agg.totals.requests)} runs`}
            />
            <KpiCard
              label="Live LLM spend"
              value={formatUSD(agg.totals.actualCostUsd)}
              sub={agg.totals.chatRequests > 0
                ? `${agg.totals.chatRequests} governed ${agg.totals.chatRequests === 1 ? 'call' : 'calls'} · exact provider usage, incl. output`
                : 'no live calls yet — “Ask the LLM” counts here'}
              tone="plain"
            />
            <KpiCard
              label="Projected annual"
              value={formatUSD(agg.projectedAnnualUsd)}
              sub="window rate × 365 — a projection, not a promise"
            />
            <KpiCard
              label="Spend if unoptimized"
              value={formatUSD(agg.totals.costOriginalUsd)}
              sub={`now: ${formatUSD(agg.totals.costOptimizedUsd)} · avoided ${formatPercent(agg.totals.reductionPercent)}`}
              tone="plain"
            />
            <KpiCard
              label="Tokens avoided"
              value={formatNumber(agg.totals.savedTokens)}
              sub="prompt input tokens the models never processed"
              tone="violet"
            />
          </div>

          {/* trend + breakdown */}
          <div className="mt-4 grid gap-4 lg:grid-cols-5">
            <div className="card p-4 lg:col-span-2">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">Daily savings</h3>
              <TrendChart data={agg.series} />
            </div>
            <div className="card overflow-hidden lg:col-span-3">
              <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">Breakdown</h3>
                <label className="flex items-center gap-2 text-xs text-mist">
                  group by
                  <select
                    value={groupBy}
                    onChange={(e) => setGroupBy(e.target.value)}
                    aria-label="Group by"
                    className="card cursor-pointer bg-ink-800 px-2 py-1 text-xs text-slate-soft"
                  >
                    <option value="">nothing (totals)</option>
                    {facetKeys.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                    <option value="__user">user</option>
                  </select>
                </label>
              </div>
              {!bucketCols ? (
                <p className="px-4 py-6 text-sm text-mist">Pick a tag (or “user”) to split the numbers — e.g. group by <span className="font-mono text-violet-soft">cost_center</span> to see each center&apos;s share of savings.</p>
              ) : (
                <div className="max-h-80 overflow-y-auto thin-scroll">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-ink-800 text-[11px] uppercase tracking-wider text-mist">
                      <tr>
                        <th className="px-4 py-2 font-semibold">{agg.groupBy[0] === '__user' ? 'User' : agg.groupBy.join(' / ')}</th>
                        <th className="px-2 py-2 text-right font-semibold">Users</th>
                        <th className="px-2 py-2 text-right font-semibold">Runs</th>
                        <th className="px-2 py-2 text-right font-semibold">Spend now</th>
                        <th className="px-2 py-2 text-right font-semibold">Saved</th>
                        <th className="px-4 py-2 text-right font-semibold">−%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agg.buckets.map((b) => (
                        <tr key={b.label} className="border-t border-line/60 transition-colors hover:bg-ink-700/40">
                          <td className="px-4 py-2 font-mono text-xs text-slate-soft">{b.label}</td>
                          <td className="px-2 py-2 text-right font-mono text-xs text-mist">{b.users}</td>
                          <td className="px-2 py-2 text-right font-mono text-xs text-mist">{formatNumber(b.requests)}</td>
                          <td className="px-2 py-2 text-right font-mono text-xs text-slate-soft">{formatUSD(b.costOptimizedUsd)}</td>
                          <td className="px-2 py-2 text-right font-mono text-xs text-mint">{formatUSD(b.savingsUsd)}</td>
                          <td className="px-4 py-2 text-right font-mono text-xs text-violet-soft">{formatPercent(b.reductionPercent)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-line bg-ink-800/60 text-xs">
                        <td className="px-4 py-2 font-semibold text-mist">TOTAL</td>
                        <td className="px-2 py-2 text-right font-mono text-mist">{totals!.users}</td>
                        <td className="px-2 py-2 text-right font-mono text-mist">{formatNumber(totals!.requests)}</td>
                        <td className="px-2 py-2 text-right font-mono text-mist">{formatUSD(totals!.costOptimizedUsd)}</td>
                        <td className="px-2 py-2 text-right font-mono text-mint">{formatUSD(totals!.savingsUsd)}</td>
                        <td className="px-4 py-2 text-right font-mono text-mist">{formatPercent(totals!.reductionPercent)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-mist">
            Costs are USD, input-side for optimizer runs (prompt optimization
            reduces input tokens), and exact in+out from provider-reported
            usage for live “Ask the LLM” calls — all priced from the model
            table at the moment each run was recorded. Filters match the tag
            snapshot stored with each run, so numbers stay true even if
            someone changes their tags later.
            {filters.length > 0 && <> Currently filtered: <span className="font-mono text-violet-soft">{filters.map((f) => `${f.key}=${f.value}`).join(' AND ')}</span>.</>}
          </p>
        </>
      )}
    </section>
  );
}

/** Cascading key → value picker fed by /api/tags/facets. */
function FilterPicker({ facets, onPick, disabled }: {
  facets: Facet[];
  onPick(key: string, value: string): void;
  disabled: boolean;
}) {
  const [key, setKey] = useState('');
  const facet = facets.find((f) => f.key === key);
  if (disabled) return null;
  return (
    <span className="flex items-center gap-1.5">
      {!facet && (
        <select
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-label="Filter tag key"
          className="card cursor-pointer rounded-full bg-ink-800 px-2 py-0.5 text-xs text-mist"
        >
          <option value="">+ tag…</option>
          {facets.map((f) => (
            <option key={f.key} value={f.key}>{f.key}</option>
          ))}
        </select>
      )}
      {facet && (
        <>
          <select
            value=""
            onChange={(e) => { if (e.target.value) onPick(facet.key, e.target.value); setKey(''); }}
            aria-label="Filter tag value"
            className="card cursor-pointer rounded-full bg-ink-800 px-2 py-0.5 text-xs text-mist"
          >
            <option value="">{facet.key} = …</option>
            {facet.values.map((v) => (
              <option key={v.value} value={v.value}>{v.value} ({v.events})</option>
            ))}
          </select>
          <button onClick={() => setKey('')} aria-label="Cancel tag filter pick" className="text-xs text-mist hover:text-danger">✕</button>
        </>
      )}
    </span>
  );
}
