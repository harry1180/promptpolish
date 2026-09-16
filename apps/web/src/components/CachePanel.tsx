import { useState } from 'react';
import { EVICTION_POLICIES } from '@promptslim/cache';
import { getPromptCache } from '../hooks/useCache';
import type { PromptSlim } from '../hooks/usePromptSlim';
import { formatNumber } from '@promptslim/pricing-engine';

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  'exact-hit': { label: 'EXACT HIT', cls: 'border-mint/50 bg-mint/10 text-mint' },
  'semantic-hit': { label: 'SEMANTIC HIT', cls: 'border-mint/50 bg-mint/10 text-mint' },
  partial: { label: 'PARTIAL NEIGHBOR', cls: 'border-amber-soft/50 bg-amber-soft/10 text-amber-soft' },
  'blocked-governance': { label: 'BLOCKED (GOVERNANCE)', cls: 'border-danger/50 bg-danger/10 text-danger' },
  miss: { label: 'MISS', cls: 'border-line bg-ink-900 text-mist' },
};

/**
 * Cache engine panel: what the last lookup decided, the live stats, and the
 * eviction-policy comparison (live SIEVE vs shadow policies vs Belady optimal).
 * Similarity is LOCAL LEXICAL (feature-hashing cosine), not embeddings — the
 * copy must keep saying so.
 */
export function CachePanel({ slim }: { slim: PromptSlim }) {
  const { cacheStats, cacheOutcome, recordMeasuredOutput } = slim;
  const [measured, setMeasured] = useState('');
  const [savedMsg, setSavedMsg] = useState(false);

  const stats = cacheStats;
  const belady = stats.policyStats.find((p) => p.policy === 'belady');
  const live = stats.policyStats.find((p) => p.policy === stats.livePolicy);
  const gap = belady && live ? belady.hitRate - live.hitRate : 0;

  const outcome = cacheOutcome
    ? STATUS_STYLE[cacheOutcome.status] ?? STATUS_STYLE['miss']!
    : null;

  return (
    <section className="card overflow-hidden" aria-label="Cache engine" id="cache">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-mist">
          Local cache · policy comparison
        </h2>
        <div className="flex items-center gap-3 text-[11px] text-mist">
          <span className="font-mono">{stats.size}/{stats.capacity} entries</span>
          <button
            onClick={() => { slim.clearCache(); setSavedMsg(false); }}
            className="rounded-md border border-line px-2 py-1 text-mist transition-colors hover:border-danger/40 hover:text-danger"
            aria-label="Clear cache"
          >
            Clear cache
          </button>
        </div>
      </div>

      {/* last lookup outcome */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3 text-xs">
        {outcome ? (
          <>
            <span className={`rounded-full border px-2.5 py-1 font-semibold tracking-wider ${outcome.cls}`}>
              {outcome.label}
            </span>
            {cacheOutcome && cacheOutcome.similarity > 0 && cacheOutcome.similarity < 1 && (
              <span className="font-mono text-mist">
                {`sim ${(cacheOutcome.similarity * 100).toFixed(0)}%`}
                <span className="text-mist/50"> (local lexical)</span>
              </span>
            )}
            <span className="min-w-0 flex-1 text-mist/90">{cacheOutcome?.note}</span>
            {cacheOutcome?.status === 'partial' && cacheOutcome.partialContext?.neighborOutputTokens != null && (
              <span className="rounded border border-amber-soft/30 bg-amber-soft/5 px-2 py-1 text-amber-soft">
                calibration hint: neighbor output ~{formatNumber(cacheOutcome.partialContext.neighborOutputTokens)} tok
              </span>
            )}
          </>
        ) : (
          <span className="text-mist/70">
            Optimize a prompt to exercise the cache. Re-running the same prompt returns the stored response;
            very similar ones reuse it only when governance says both sides are clean.
          </span>
        )}
      </div>

      {/* savings so far */}
      <div className="grid grid-cols-2 gap-px border-b border-line bg-line md:grid-cols-4">
        {[
          ['Lookups', formatNumber(stats.totalLookups)],
          ['Responses served from cache', formatNumber(stats.servedHits)],
          ['Prompts skipped', formatNumber(stats.exactHits + stats.semanticHits)],
          ['Tokens not re-processed', formatNumber(stats.savedTokens)],
        ].map(([label, value]) => (
          <div key={label} className="bg-ink-800/60 px-5 py-3">
            <div className="text-[10px] uppercase tracking-wider text-mist">{label}</div>
            <div className="mt-0.5 font-mono text-lg text-slate-soft">{value}</div>
          </div>
        ))}
      </div>

      {/* policy comparison */}
      <div className="px-5 py-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-mist">
            Eviction policies on your own traffic
          </h3>
          <span className="text-[11px] text-mist/70">
            live: SIEVE · shadow: would-have-served rates · gap to optimal: {belady && live ? `${(gap * 100).toFixed(1)}%` : '—'}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-mist">
                <th className="py-2 pr-3 font-medium">Policy</th>
                <th className="py-2 pr-3 font-medium">Role</th>
                <th className="py-2 pr-3 font-medium text-right">Hits</th>
                <th className="py-2 pr-3 font-medium text-right">Hit rate</th>
                <th className="py-2 pr-3 font-medium text-right">Evictions</th>
                <th className="py-2 font-medium">How it decides</th>
              </tr>
            </thead>
            <tbody>
              {EVICTION_POLICIES.map((p) => {
                const s = stats.policyStats.find((x) => x.policy === p.id)!;
                return (
                  <tr key={p.id} className={`border-b border-line/50 last:border-0 ${p.live ? 'bg-mint/[0.05]' : ''}`} title={`${p.pros}\n\nWeaknesses: ${p.cons}`}>
                    <td className="py-2 pr-3 font-medium text-slate-soft">
                      {p.label}
                      {p.live && <span className="ml-1.5 rounded bg-mint/15 px-1.5 py-0.5 text-[9px] font-semibold text-mint">LIVE</span>}
                      {p.oracle && <span className="ml-1.5 rounded bg-ink-700 px-1.5 py-0.5 text-[9px] text-mist">ORACLE</span>}
                    </td>
                    <td className="py-2 pr-3 text-xs text-mist">{p.oracle ? 'upper bound' : p.live ? 'serving' : 'shadow'}</td>
                    <td className="py-2 pr-3 text-right font-mono text-mist">{s.hits}</td>
                    <td className="py-2 pr-3 text-right font-mono text-slate-soft">
                      {stats.totalLookups ? `${(s.hitRate * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-mist">{p.oracle ? '—' : s.evictions}</td>
                    <td className="max-w-md py-2 text-[11px] leading-snug text-mist/80">{p.oneLiner}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* calibration input — the concrete alternative to fixed ratios */}
        <div className="mt-4 flex flex-wrap items-end gap-x-5 gap-y-2 rounded-lg border border-violet-soft/25 bg-violet-soft/[0.04] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-violet-soft">Calibrate output estimates with real measurements</div>
            <p className="mt-0.5 text-[11px] leading-snug text-mist/80">
              Ran this prompt for real? Enter the actual response length — after enough measurements for the
              same model + shape, estimates switch from the fixed prior to your data (the card will say
              “calibrated”). Stored only in this browser.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number" min={1} step={10} value={measured}
              onChange={(e) => setMeasured(e.target.value)}
              placeholder="actual output tokens"
              className="card w-44 bg-ink-900 px-3 py-1.5 font-mono text-sm text-slate-soft"
              aria-label="Measured output tokens"
            />
            <button
              onClick={() => {
                const n = Number(measured);
                if (recordMeasuredOutput(n)) {
                  setSavedMsg(true);
                  setMeasured('');
                  setTimeout(() => setSavedMsg(false), 1600);
                }
              }}
              disabled={!measured || !(Number(measured) > 0)}
              className="rounded-md border border-violet-soft/50 bg-violet-soft/10 px-3 py-1.5 text-xs font-semibold text-violet-soft transition-colors hover:bg-violet-soft/20 disabled:opacity-40"
            >
              Save measurement
            </button>
          </div>
          {savedMsg && <span className="text-xs text-mint">saved · will calibrate after 3+ points</span>}
        </div>
      </div>

      {/* cached entries */}
      {stats.size > 0 && (
        <div className="border-t border-line px-5 py-3">
          <details>
            <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wider text-mist">
              Cached prompts ({stats.size})
            </summary>
            <ul className="mt-2 space-y-1.5">
              {getPromptCache().snapshotEntries().slice().reverse().map((e) => (
                <li key={e.id} className="flex items-center gap-2 text-xs">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${e.governanceClean ? 'bg-mint' : 'bg-danger'}`}
                    title={e.governanceClean ? 'governance-clean (reusable)' : 'PII-bearing (exact-hit only)'} />
                  <span className="min-w-0 flex-1 truncate font-mono text-mist">{e.preview}</span>
                  <span className="shrink-0 text-mist/60">{e.level} · {e.hits} hit{e.hits === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
