/**
 * Strategies — champion strategy cards (weights, factors, performance,
 * notes) with challenger sub-cards, plus the promotion gate note.
 */

import { getStrategies } from '../api';
import type { Strategy, StrategiesResponse } from '../api';
import { Link, useEndpoint } from '../data';
import { Badge, Card, Chips, EmptyState, ErrorState, HBar, Loading, number, pct, pctPlain, toneClass } from '../ui';

function challengerTone(status: string): 'pos' | 'neg' | 'warn' | 'info' | 'neutral' {
  const s = status.toUpperCase();
  if (s === 'CANDIDATE') return 'pos';
  if (s === 'SHADOW') return 'info';
  if (s === 'BACKTEST') return 'warn';
  return 'neutral';
}

function StrategyCard({ s }: { s: Strategy }) {
  const weights = Object.entries(s.weights ?? {});
  const maxWeight = Math.max(...weights.map(([, v]) => Math.abs(v ?? 0)), 0.0001);

  return (
    <Card
      title={s.name}
      subtitle={`${s.id} · ${s.horizon} · version ${s.version ?? '—'}`}
      actions={
        <span className="flex gap-1.5">
          <Badge tone={s.active ? 'pos' : 'neutral'}>{s.active ? 'ACTIVE' : 'INACTIVE'}</Badge>
          {s.champion && <Badge tone="info">CHAMPION</Badge>}
        </span>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-mist">Weights</div>
          {weights.length === 0 ? (
            <p className="mt-1 text-xs text-mist">no weights published</p>
          ) : (
            <div className="mt-1 space-y-0.5">
              {weights.map(([k, v]) => (
                <HBar key={k} label={k} value={v ?? 0} display={number(v ?? null)} tone="info" max={maxWeight} />
              ))}
            </div>
          )}
          <div className="mt-3 text-[10px] uppercase tracking-wider text-mist">Factors</div>
          <div className="mt-1">
            <Chips items={s.factors ?? []} />
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-mist">Performance</div>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <div className="rounded border border-line bg-ink-900/70 px-2 py-1">
              <div className="text-[10px] uppercase text-mist">Trades</div>
              <div className="font-mono text-sm text-slate-soft">{number(s.performance?.trades ?? null)}</div>
            </div>
            <div className="rounded border border-line bg-ink-900/70 px-2 py-1">
              <div className="text-[10px] uppercase text-mist">Win rate</div>
              <div className="font-mono text-sm text-slate-soft">{pctPlain(s.performance?.winRatePct ?? null)}</div>
            </div>
            <div className="rounded border border-line bg-ink-900/70 px-2 py-1">
              <div className="text-[10px] uppercase text-mist">Return</div>
              <div className={`font-mono text-sm ${toneClass(s.performance?.returnPct ?? null)}`}>{pct(s.performance?.returnPct ?? null)}</div>
            </div>
            <div className="rounded border border-line bg-ink-900/70 px-2 py-1">
              <div className="text-[10px] uppercase text-mist">Excess</div>
              <div className={`font-mono text-sm ${toneClass(s.performance?.excessReturnPct ?? null)}`}>{pct(s.performance?.excessReturnPct ?? null)}</div>
            </div>
          </div>
          {s.notes && <p className="mt-2 text-xs text-mist">{s.notes}</p>}
        </div>
      </div>

      <div className="mt-3 border-t border-line pt-3">
        <div className="text-[10px] uppercase tracking-wider text-mist">Challengers</div>
        {(s.challengers ?? []).length === 0 ? (
          <p className="mt-1 text-xs text-mist">no challengers registered</p>
        ) : (
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            {(s.challengers ?? []).map((c) => (
              <div key={c.id} className="rounded-md border border-line bg-ink-900/70 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-slate-soft">{c.name}</span>
                  <Badge tone={challengerTone(c.status)}>{c.status}</Badge>
                </div>
                <div className="mt-1 font-mono text-[11px] text-mist">
                  {c.id} · {number(c.observations ?? null)} observations
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

export function StrategiesPage() {
  const ep = useEndpoint<StrategiesResponse>('/strategies', getStrategies);

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading strategies…" />;
  }
  const strategies = ep.data.strategies ?? [];

  return (
    <div className="space-y-4">
      <p className="border-l-2 border-violet-soft/60 bg-ink-900/70 py-2 pl-3 text-xs text-mist">
        Promotion into the champion slot requires a full backtest, walk-forward validation and shadow observation —
        a challenger never goes live on a single good stretch. See{' '}
        <Link to="/tradingusa/backtests" className="text-mint underline">
          Backtests
        </Link>
        .
      </p>

      {strategies.length === 0 ? (
        <EmptyState title="No strategies registered">GET /strategies returned no strategy versions.</EmptyState>
      ) : (
        <div className="space-y-4">
          {strategies.map((s) => (
            <StrategyCard key={`${s.id}-${s.version ?? ''}`} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}