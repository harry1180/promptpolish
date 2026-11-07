/**
 * Market — session timeline strip, regime, indexes, breadth, VIX, treasury
 * yields + 10y-2y spread, sector performance bars and the next holiday.
 */

import { getMarket } from '../api';
import type { MarketResponse, SessionKind } from '../api';
import { useEndpoint } from '../data';
import {
  Card,
  ConfidenceBar,
  DataTable,
  EmptyState,
  ErrorState,
  HBar,
  Loading,
  SessionBadge,
  Sparkline,
  StatTile,
  dateText,
  money,
  number,
  pct,
  pctAuto,
  toneClass,
} from '../ui';

const TIMELINE: Array<{ kind: SessionKind | 'CLOSED'; label: string }> = [
  { kind: 'PREMARKET', label: 'Pre' },
  { kind: 'MARKET_OPEN', label: 'Open' },
  { kind: 'POSTMARKET', label: 'Post' },
  { kind: 'CLOSED', label: 'Closed' },
];

function isLive(session: string | undefined, step: (typeof TIMELINE)[number]['kind']): boolean {
  const s = session ?? '';
  if (step === 'CLOSED') return s === 'MARKET_CLOSED' || s === 'WEEKEND' || s === 'HOLIDAY';
  return s === step;
}

export function MarketPage() {
  const ep = useEndpoint<MarketResponse>('/market', getMarket);

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading market…" />;
  }
  const d = ep.data;
  const current = d.market?.session;
  const breadth = d.breadth;
  const total = (breadth?.advancers ?? 0) + (breadth?.decliners ?? 0);
  const advShare = total > 0 ? ((breadth?.advancers ?? 0) / total) * 100 : 0;
  const sectors = [...(d.sectorPerformance ?? [])].sort((a, b) => (b.ret20dPct ?? -Infinity) - (a.ret20dPct ?? -Infinity));
  const sectorMax = Math.max(...sectors.map((s) => Math.abs(s.ret20dPct ?? 0)), 1);

  return (
    <div className="space-y-4">
      {/* session timeline */}
      <Card title="Session timeline" subtitle={`today ${dateText(d.market?.date ?? null)} · ${current ?? '—'}`}>
        <div className="flex gap-1">
          {TIMELINE.map((step) => {
            const live = isLive(current, step.kind);
            return (
              <div
                key={step.kind}
                className={`flex-1 rounded-md border px-3 py-2 text-center text-xs ${
                  live
                    ? step.kind === 'MARKET_OPEN'
                      ? 'border-mint/50 bg-mint/10 text-mint'
                      : step.kind === 'CLOSED'
                        ? 'border-line bg-ink-700 text-mist'
                        : 'border-violet-soft/50 bg-violet-soft/10 text-violet-soft'
                    : 'border-line bg-ink-900/60 text-mist/60'
                }`}
              >
                {step.label}
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-mist">
          <SessionBadge session={current} date={d.market?.date ?? null} />
          {d.market?.nextSession && (
            <span className="font-mono">next session {dateText(d.market.nextSession.date)}</span>
          )}
          {d.sessions?.today && (
            <span className="font-mono">today: {d.sessions.today.session} · {dateText(d.sessions.today.date)}</span>
          )}
          {d.sessions?.next && (
            <span className="font-mono">next: {d.sessions.next.session} · {dateText(d.sessions.next.date)}</span>
          )}
          {d.sessions?.holidayUpcoming && (
            <span className="font-mono text-amber-soft">
              holiday {dateText(d.sessions.holidayUpcoming.date)} · {d.sessions.holidayUpcoming.name}
            </span>
          )}
        </div>
      </Card>

      {/* regime */}
      <Card title="Regime" subtitle={d.regime?.regime ?? '—'}>
        <ConfidenceBar value={d.regime?.confidence ?? null} />
        {d.regime?.components && (
          <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {Object.entries(d.regime.components).map(([k, v]) => (
              <div key={k} className="flex justify-between text-xs">
                <span className="text-mist">{k}</span>
                <span className="font-mono text-slate-soft">{number(v)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* indexes */}
      <Card title="Indexes">
        <div className="grid gap-3 sm:grid-cols-3">
          {(d.indexes ?? []).map((q) => (
            <div key={q.symbol} className="card p-3">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-sm font-semibold text-slate-soft">{q.symbol}</span>
                <span className={`font-mono text-sm ${toneClass(q.changePct)}`}>{pct(q.changePct)}</span>
              </div>
              <div className="mt-1 flex items-end justify-between">
                <span className="font-mono text-lg text-slate-soft">{money(q.price)}</span>
                <Sparkline values={[q.prevClose, q.price]} ariaLabel={`${q.symbol} vs previous close`} tone={toneClass(q.changePct) === 'text-danger' ? 'neg' : 'pos'} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* breadth + vix */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Advancers"
          value={number(breadth?.advancers ?? null)}
          hint={breadth?.asOf ? `as of ${dateText(String(breadth.asOf))}` : '—'}
        />
        <StatTile label="Decliners" value={number(breadth?.decliners ?? null)} />
        <StatTile label="VIX" value={number(d.volatility?.vix ?? null)} />
        <StatTile
          label="10y – 2y spread"
          value={pctAuto(d.curve?.spread10y2y ?? null)}
          tone={toneClass(d.curve?.spread10y2y ?? null) as 'pos' | 'neg' | 'info' | 'warn' | 'neutral'}
          hint={d.curve?.asOf ? `as of ${dateText(String(d.curve.asOf))}` : 'curve unavailable'}
        />
      </div>

      {total > 0 && (
        <Card title="Breadth">
          <div className="h-2 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-mint-dim" style={{ width: `${advShare}%` }} />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[11px]">
            <span className="text-mint">{number(breadth?.advancers ?? null)} up</span>
            <span className="text-danger">{number(breadth?.decliners ?? null)} down</span>
          </div>
        </Card>
      )}

      {/* treasury yields */}
      <Card title="Treasury yields" subtitle="Constant-maturity yields, latest snapshots.">
        <DataTable
          label="Treasury yields"
          rows={d.yields ?? []}
          rowKey={(r) => r.date}
          columns={[
            { key: 'date', header: 'Date', cell: (r) => <span className="font-mono text-xs">{dateText(r.date)}</span> },
            { key: 'y2', header: '2y', align: 'right', cell: (r) => <span className="font-mono">{pctAuto(r.y2 ?? null)}</span> },
            { key: 'y5', header: '5y', align: 'right', cell: (r) => <span className="font-mono">{pctAuto(r.y5 ?? null)}</span> },
            { key: 'y10', header: '10y', align: 'right', cell: (r) => <span className="font-mono">{pctAuto(r.y10 ?? null)}</span> },
            { key: 'y30', header: '30y', align: 'right', cell: (r) => <span className="font-mono">{pctAuto(r.y30 ?? null)}</span> },
          ]}
          empty={<p className="py-3 text-center text-xs text-mist">No yield data published yet.</p>}
        />
        <p className="mt-2 text-xs text-mist">
          10y − 2y spread: <span className={`font-mono ${toneClass(d.curve?.spread10y2y ?? null)}`}>{pctAuto(d.curve?.spread10y2y ?? null)}</span>
          {d.curve?.asOf ? ` · as of ${dateText(String(d.curve.asOf))}` : ''}
        </p>
      </Card>

      {/* sectors */}
      <Card title="Sector performance" subtitle="20-day total return, descending.">
        {sectors.length === 0 ? (
          <EmptyState title="No sector data">Sector performance has not been published for this window.</EmptyState>
        ) : (
          <div className="space-y-0.5">
            {sectors.map((s) => (
              <HBar
                key={s.sector}
                label={s.sector}
                value={s.ret20dPct ?? 0}
                display={pct(s.ret20dPct)}
                tone={(s.ret20dPct ?? 0) >= 0 ? 'pos' : 'neg'}
                max={sectorMax}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}