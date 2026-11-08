/**
 * Paper Trading — the single spot book: open positions with entry fees and
 * unrealized P&L, then every closed trade with fee-inclusive net returns,
 * the BTC benchmark and predicted-vs-actual.
 */

import { getPositions, getTrades, winRateHint } from '../api';
import type { PositionRowView, TradeRowView } from '../api';
import { useEndpoint } from '../data';
import {
  Badge,
  Card,
  DataTable,
  StatTile,
  dateText,
  money,
  pageState,
  pct,
  toneClass,
  toneFor,
} from '../../tradingusa/ui';
import type { Column } from '../../tradingusa/ui';

const openColumns: Array<Column<PositionRowView>> = [
  { key: 'coin', header: 'Coin', cell: (p) => <span className="font-mono text-slate-soft">{p.ticker}</span>, sortValue: (p) => p.ticker },
  { key: 'qty', header: 'Qty', cell: (p) => <span className="font-mono">{p.qty.toFixed(6)}</span>, align: 'right' },
  { key: 'entry', header: 'Entry', cell: (p) => <span className="font-mono">{money(p.entryPrice)}</span>, align: 'right', sortValue: (p) => p.entryPrice },
  { key: 'last', header: 'Last', cell: (p) => <span className="font-mono">{money(p.currentPrice)}</span>, align: 'right', sortValue: (p) => p.currentPrice },
  { key: 'fee', header: 'Entry fee', cell: (p) => <span className="font-mono text-mist">{money(p.entryFee)}</span>, align: 'right' },
  { key: 'pnl', header: 'uPnL', cell: (p) => <span className={`font-mono ${toneClass(p.unrealized)}`}>{money(p.unrealized)}</span>, align: 'right', sortValue: (p) => p.unrealized },
  { key: 'pnlPct', header: 'uPnL %', cell: (p) => <span className={`font-mono ${toneClass(p.unrealizedPct)}`}>{pct(p.unrealizedPct)}</span>, align: 'right', sortValue: (p) => p.unrealizedPct },
  { key: 'mfe', header: 'Best', cell: (p) => <span className="font-mono text-xs">{pct((p.mfe ?? 0) * 100)}</span>, align: 'right' },
  { key: 'mae', header: 'Worst', cell: (p) => <span className="font-mono text-xs">{pct((p.mae ?? 0) * 100)}</span>, align: 'right' },
  { key: 'stop', header: 'Stop', cell: (p) => <span className="font-mono">{money(p.stop)}</span>, align: 'right' },
  { key: 'target', header: 'Target', cell: (p) => <span className="font-mono">{money(p.target)}</span>, align: 'right' },
  { key: 'held', header: 'Held', cell: (p) => <span className="font-mono">{p.sessionsHeld}d</span>, align: 'right', sortValue: (p) => p.sessionsHeld },
];

const closedColumns: Array<Column<TradeRowView>> = [
  { key: 'coin', header: 'Coin', cell: (t) => <span className="font-mono text-slate-soft">{t.ticker}</span>, sortValue: (t) => t.ticker },
  { key: 'entry', header: 'Entry', cell: (t) => <span className="font-mono text-xs">{dateText(t.entryTs)}</span> },
  { key: 'exit', header: 'Exit', cell: (t) => <span className="font-mono text-xs">{dateText(t.exitTs)}</span>, sortValue: (t) => t.exitTs },
  { key: 'reason', header: 'Exit reason', cell: (t) => <Badge tone="neutral">{t.exitReason.replace(/_/g, ' ')}</Badge> },
  { key: 'net', header: 'Net %', cell: (t) => <span className={`font-mono ${toneClass(t.returnPct)}`}>{pct(t.returnPct)}</span>, align: 'right', sortValue: (t) => t.returnPct },
  { key: 'bench', header: 'BTC %', cell: (t) => <span className={`font-mono ${toneClass(t.benchmarkReturnPct)}`}>{pct(t.benchmarkReturnPct)}</span>, align: 'right' },
  { key: 'excess', header: 'Excess', cell: (t) => <span className={`font-mono ${toneClass(t.excessReturnPct)}`}>{pct(t.excessReturnPct)}</span>, align: 'right', sortValue: (t) => t.excessReturnPct },
  { key: 'pred', header: 'Predicted', cell: (t) => <span className="font-mono text-mist">{pct(t.predictedReturnPct)}</span>, align: 'right' },
  { key: 'net$', header: 'Net $', cell: (t) => <span className={`font-mono ${toneClass(t.netPnl)}`}>{money(t.netPnl)}</span>, align: 'right', sortValue: (t) => t.netPnl },
  { key: 'hold', header: 'Hold', cell: (t) => <span className="font-mono">{t.holdingSessions}d</span>, align: 'right' },
];

export function PaperTradingPage() {
  const positions = useEndpoint('/positions', getPositions);
  const trades = useEndpoint('/trades?limit=50', () => getTrades(50));

  const state = pageState(trades.data, trades.error, trades.reload, 'Loading the paper book…');
  if (state) return state;

  const open = positions.data?.positions ?? [];
  const stats = trades.data?.stats;
  const closed = trades.data?.trades ?? [];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatTile label="Open" value={String(open.length)} hint="spot, long-only" />
        <StatTile label="Closed" value={String(stats?.closed ?? 0)} />
        <StatTile label="Win rate" value={`${stats?.winRatePct ?? 0}%`} hint={winRateHint(stats)} />
        <StatTile label="Net P&L" value={money(stats?.netPnl ?? 0)} tone={toneFor(stats?.netPnl ?? 0)} hint="after fees" />
        <StatTile label="Avg trade" value={pct(stats?.avgReturnPct ?? 0)} tone={toneFor(stats?.avgReturnPct ?? 0)} />
        <StatTile label="Fees paid" value={money(stats?.feesPaid ?? 0)} hint={`${stats?.avgHoldSessions ?? 0}d avg hold`} />
      </div>

      <Card
        title="Open positions"
        subtitle="entry fee is charged at fill; exit fee is deducted at close — net P&L is always fee-inclusive"
      >
        <DataTable
          rows={open}
          columns={openColumns}
          rowKey={(p) => String(p.id)}
          label="open crypto positions"
          empty={<p className="py-4 text-sm text-mist">No open positions right now.</p>}
          defaultSort={{ key: 'pnlPct', dir: 'desc' }}
        />
      </Card>

      <Card title="Closed trades" subtitle="benchmark = BTC over the same window; predicted comes from the signal that opened the trade">
        <DataTable
          rows={closed}
          columns={closedColumns}
          rowKey={(t) => String(t.id)}
          label="closed crypto trades"
          empty={<p className="py-4 text-sm text-mist">No closed trades yet.</p>}
          defaultSort={{ key: 'exit', dir: 'desc' }}
        />
      </Card>
    </div>
  );
}
