/**
 * Signals — every BUY/SELL the crypto scanner published, filterable by side
 * and by session date (crypto has one session: today).
 */

import { useState } from 'react';
import { getSignals } from '../api';
import type { SignalRowView, SignalsResponse } from '../api';
import { useEndpoint } from '../data';
import { Badge, Card, ConfidenceBar, DataTable, pageState, pct, time, toneClass } from '../../tradingusa/ui';
import type { Column } from '../../tradingusa/ui';

const columns: Array<Column<SignalRowView>> = [
  { key: 'coin', header: 'Coin', cell: (s) => <span className="font-mono text-slate-soft">{s.ticker}</span>, sortValue: (s) => s.ticker },
  { key: 'signal', header: 'Signal', cell: (s) => <Badge tone={s.signal === 'BUY' ? 'pos' : 'neg'}>{s.signal}</Badge>, sortValue: (s) => s.signal },
  { key: 'conf', header: 'Confidence', cell: (s) => <ConfidenceBar value={s.confidence} />, sortValue: (s) => s.confidence },
  { key: 'price', header: 'Price', cell: (s) => <span className="font-mono">{Number(s.price).toLocaleString('en-US', { maximumFractionDigits: 6 })}</span>, align: 'right', sortValue: (s) => s.price },
  { key: 'target', header: 'Target', cell: (s) => <span className="font-mono">{Number(s.target).toLocaleString('en-US', { maximumFractionDigits: 6 })}</span>, align: 'right' },
  { key: 'invalid', header: 'Invalidation', cell: (s) => <span className="font-mono">{Number(s.invalidation).toLocaleString('en-US', { maximumFractionDigits: 6 })}</span>, align: 'right' },
  { key: 'exp', header: 'Exp. ret', cell: (s) => <span className={`font-mono ${toneClass(s.expectedReturnPct)}`}>{pct(s.expectedReturnPct)}</span>, align: 'right', sortValue: (s) => s.expectedReturnPct },
  { key: 'rr', header: 'R:R', cell: (s) => <span className="font-mono">{Number(s.riskReward).toFixed(2)}</span>, align: 'right', sortValue: (s) => s.riskReward },
  { key: 'regime', header: 'Regime', cell: (s) => <span className="text-xs text-mist">{s.regime.toLowerCase()}</span> },
  { key: 'date', header: 'Date', cell: (s) => <span className="font-mono text-xs">{s.signalDate} · {time(s.createdAt)}</span>, sortValue: (s) => s.createdAt },
];

export function SignalsPage() {
  const [side, setSide] = useState<string>('');
  const [date, setDate] = useState<string>('');
  const queryKey = `${side}|${date}`;
  const signals = useEndpoint<SignalsResponse>(
    `/signals?${queryKey}`,
    () => getSignals({ limit: 100, ...(side ? { signal: side } : {}), ...(date ? { date } : {}) }),
  );

  const state = pageState(signals.data, signals.error, signals.reload, 'Loading signals…');
  if (state) return state;

  const rows = signals.data?.signals ?? [];

  return (
    <div className="space-y-4">
      <Card
        title="Filters"
        subtitle="one signal per coin per session — re-runs are deduplicated, never double-emitted"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {[
              { key: '', label: 'All' },
              { key: 'BUY', label: 'Buy' },
              { key: 'SELL', label: 'Sell' },
            ].map((f) => (
              <button
                key={f.key || 'all'}
                type="button"
                onClick={() => setSide(f.key)}
                className={`rounded-md border px-3 py-1 text-xs ${
                  side === f.key ? 'border-mint bg-mint/10 text-mint' : 'border-line text-mist hover:text-slate-soft'
                }`}
              >
                {f.label}
              </button>
            ))}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="filter signals by date"
              className="rounded-md border border-line bg-ink-900 px-2 py-1 text-xs text-slate-soft"
            />
            {(side || date) && (
              <button
                type="button"
                onClick={() => { setSide(''); setDate(''); }}
                className="rounded-md border border-line px-3 py-1 text-xs text-mist hover:text-slate-soft"
              >
                Reset
              </button>
            )}
          </div>
        }
      >
        <p className="text-xs text-mist">{rows.length} signal{rows.length === 1 ? '' : 's'} in view.</p>
      </Card>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(s) => String(s.id)}
        label="crypto signals"
        empty={<p className="py-4 text-sm text-mist">No signals for this filter — the scanner runs every 5 minutes, 24/7.</p>}
        defaultSort={{ key: 'date', dir: 'desc' }}
      />
    </div>
  );
}
