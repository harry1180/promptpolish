/**
 * Report — day-by-day metrics for ANY date range so consecutive days can be
 * compared directly: signals vs gate-blocked, trades opened/closed, win rate,
 * expectancy, stop/target exits, net PnL and end-of-day equity. Range is
 * filterable (date inputs + 7/14/30/90-day presets); the endpoint refetches
 * whenever the range changes.
 */
import { useState } from 'react';
import { getReport } from '../api';
import type { ReportResponse } from '../api';
import { useEndpoint } from '../data';
import {
  Badge,
  Card,
  DataTable,
  ErrorState,
  Loading,
  StatTile,
  dateText,
  money,
  number,
  pct,
  pctPlain,
  toneClass,
  toneFor,
} from '../ui';

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const PRESETS = [
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

export function ReportPage() {
  const [from, setFrom] = useState(() => isoDaysAgo(13));
  const [to, setTo] = useState(() => isoDaysAgo(0));
  const ep = useEndpoint<ReportResponse>(`/report?from=${from}&to=${to}`, () => getReport(from, to));

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading report…" />;
  }
  const data = ep.data;
  const t = data.totals;
  const blocked = t.blockedRegime + t.blockedLowConfidence + t.blockedLesson;

  function setPreset(days: number): void {
    setFrom(isoDaysAgo(days - 1));
    setTo(isoDaysAgo(0));
  }

  return (
    <div className="space-y-4">
      {/* range filter */}
      <Card title="Date range" subtitle="One row per day — every *Pct metric is an already-percent value.">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-md border border-line bg-ink-800 px-2 py-1 font-mono text-xs text-slate-soft"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
            To
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-md border border-line bg-ink-800 px-2 py-1 font-mono text-xs text-slate-soft"
            />
          </label>
          <div className="flex gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setPreset(p.days)}
                className="rounded-md border border-line bg-ink-800 px-2.5 py-1 font-mono text-xs text-mist hover:border-mint/50 hover:text-mint"
              >
                {p.label}
              </button>
            ))}
          </div>
          <span className="font-mono text-[11px] text-mist">
            {dateText(data.from)} → {dateText(data.to)} · {number(t.days)} days
          </span>
        </div>
        {ep.error && (
          <p role="alert" className="mt-2 text-xs text-danger">{ep.error}</p>
        )}
      </Card>

      {/* range totals */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <StatTile label="Trades closed" value={number(t.closed)} hint={`${number(t.wins)}W · ${number(t.losses)}L`} />
        <StatTile label="Win rate" value={pctPlain(t.winRatePct)} tone={t.winRatePct !== null && t.winRatePct >= 50 ? 'pos' : 'neg'} hint="range total" />
        <StatTile label="Expectancy" value={pct(t.expectancyPct)} tone={toneFor(t.expectancyPct)} hint="avg per closed trade" />
        <StatTile label="Net PnL" value={money(t.netPnl)} tone={toneFor(t.netPnl)} hint={`${number(t.stops)} stops · ${number(t.targets)} targets`} />
        <StatTile label="Signals" value={number(t.signals)} hint={`${number(t.opened)} opened · ${number(t.orders)} orders`} />
        <StatTile label="Blocked by gates" value={number(blocked)} tone="info" hint={`${number(t.blockedRegime)} regime · ${number(t.blockedLowConfidence)} confidence · ${number(t.blockedLesson)} lesson`} />
      </div>

      {/* per-day table */}
      <Card title="Daily report" subtitle="Compare any two days side by side — sort by any column.">
        <DataTable
          label="Daily report"
          rows={data.days}
          rowKey={(r) => r.date}
          defaultSort={{ key: 'date', dir: 'desc' }}
          columns={[
            { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => <span className="font-mono text-xs text-slate-soft">{dateText(r.date)}</span> },
            { key: 'regime', header: 'Regime', cell: (r) => <Badge tone="neutral">{r.regime ?? '—'}</Badge> },
            { key: 'scans', header: 'Scans', align: 'right', sortValue: (r) => r.scans, cell: (r) => <span className="font-mono text-xs text-mist">{number(r.scans)}</span> },
            { key: 'signals', header: 'Signals', align: 'right', sortValue: (r) => r.signals, cell: (r) => <span className="font-mono text-xs text-slate-soft">{number(r.signals)}</span> },
            {
              key: 'blocked',
              header: 'Blocked',
              align: 'right',
              sortValue: (r) => r.blockedRegime + r.blockedLowConfidence + r.blockedLesson,
              cell: (r) => <span className="font-mono text-xs text-amber-soft">{number(r.blockedRegime + r.blockedLowConfidence + r.blockedLesson)}</span>,
            },
            { key: 'orders', header: 'Orders', align: 'right', sortValue: (r) => r.orders, cell: (r) => <span className="font-mono text-xs text-mist">{number(r.orders)}</span> },
            { key: 'opened', header: 'Opened', align: 'right', sortValue: (r) => r.opened, cell: (r) => <span className="font-mono text-xs text-slate-soft">{number(r.opened)}</span> },
            { key: 'closed', header: 'Closed', align: 'right', sortValue: (r) => r.closed, cell: (r) => <span className="font-mono text-xs text-slate-soft">{number(r.closed)}</span> },
            { key: 'wl', header: 'W-L', align: 'right', sortValue: (r) => r.wins - r.losses, cell: (r) => <span className="font-mono text-xs">{r.closed > 0 ? `${number(r.wins)}-${number(r.losses)}` : '—'}</span> },
            { key: 'win', header: 'Win %', align: 'right', sortValue: (r) => r.winRatePct, cell: (r) => <span className={`font-mono text-xs ${r.winRatePct !== null && r.winRatePct >= 50 ? 'text-mint' : 'text-slate-soft'}`}>{pctPlain(r.winRatePct)}</span> },
            { key: 'expect', header: 'Expect %', align: 'right', sortValue: (r) => r.expectancyPct, cell: (r) => <span className={`font-mono text-xs ${toneClass(r.expectancyPct)}`}>{pct(r.expectancyPct)}</span> },
            { key: 'stops', header: 'Stops', align: 'right', sortValue: (r) => r.stops, cell: (r) => <span className="font-mono text-xs text-danger">{number(r.stops)}</span> },
            { key: 'targets', header: 'Targets', align: 'right', sortValue: (r) => r.targets, cell: (r) => <span className="font-mono text-xs text-mint">{number(r.targets)}</span> },
            { key: 'netPnl', header: 'Net PnL', align: 'right', sortValue: (r) => r.netPnl, cell: (r) => <span className={`font-mono text-xs ${toneClass(r.netPnl)}`}>{money(r.netPnl)}</span> },
            { key: 'equity', header: 'Equity', align: 'right', sortValue: (r) => r.equity, cell: (r) => <span className="font-mono text-xs text-mist">{money(r.equity)}</span> },
          ]}
          empty={<p className="py-3 text-center text-xs text-mist">No days in this range.</p>}
        />
      </Card>
    </div>
  );
}