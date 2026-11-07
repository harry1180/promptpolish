/**
 * Overview — the crypto dashboard home: equity tiles, BTC benchmark, the
 * latest scanner signals, the paper ledger stats (fee-inclusive), the equity
 * curve, open positions and the most recent closed trades.
 */

import { getOverview, getPortfolio, getSignals } from '../api';
import type { OverviewResponse, PortfolioResponse, PositionRowView, SignalRowView, SignalsResponse, TradeRowView } from '../api';
import { Link, useEndpoint } from '../data';
import {
  Badge,
  Card,
  ConfidenceBar,
  DataTable,
  LineChart,
  StatTile,
  dateText,
  money,
  number,
  pageState,
  pct,
  time,
  toneClass,
  toneFor,
} from '../../tradingusa/ui';
import type { Column } from '../../tradingusa/ui';

const positionColumns: Array<Column<PositionRowView>> = [
  { key: 'ticker', header: 'Coin', cell: (p) => <span className="font-mono text-slate-soft">{p.ticker}</span> },
  { key: 'qty', header: 'Qty', cell: (p) => <span className="font-mono">{p.qty.toFixed(4)}</span>, align: 'right' },
  { key: 'entry', header: 'Entry', cell: (p) => <span className="font-mono">{money(p.entryPrice)}</span>, align: 'right', sortValue: (p) => p.entryPrice },
  { key: 'last', header: 'Last', cell: (p) => <span className="font-mono">{money(p.currentPrice)}</span>, align: 'right', sortValue: (p) => p.currentPrice },
  { key: 'pnl', header: 'uPnL', cell: (p) => <span className={`font-mono ${toneClass(p.unrealized)}`}>{money(p.unrealized)}</span>, align: 'right', sortValue: (p) => p.unrealized },
  { key: 'pnlPct', header: 'uPnL %', cell: (p) => <span className={`font-mono ${toneClass(p.unrealizedPct)}`}>{pct(p.unrealizedPct)}</span>, align: 'right', sortValue: (p) => p.unrealizedPct },
  { key: 'stop', header: 'Stop', cell: (p) => <span className="font-mono">{money(p.stop)}</span>, align: 'right' },
  { key: 'target', header: 'Target', cell: (p) => <span className="font-mono">{money(p.target)}</span>, align: 'right' },
  { key: 'held', header: 'Held', cell: (p) => <span className="font-mono">{p.sessionsHeld}d</span>, align: 'right' },
];

const tradeColumns: Array<Column<TradeRowView>> = [
  { key: 'coin', header: 'Coin', cell: (t) => <span className="font-mono text-slate-soft">{t.ticker}</span> },
  { key: 'exit', header: 'Closed', cell: (t) => <span className="font-mono text-xs">{dateText(t.exitTs)}</span> },
  { key: 'reason', header: 'Why', cell: (t) => <span className="text-xs text-mist">{t.exitReason.replace(/_/g, ' ').toLowerCase()}</span> },
  { key: 'ret', header: 'Net %', cell: (t) => <span className={`font-mono ${toneClass(t.returnPct)}`}>{pct(t.returnPct)}</span>, align: 'right', sortValue: (t) => t.returnPct },
  { key: 'bench', header: 'BTC %', cell: (t) => <span className={`font-mono ${toneClass(t.benchmarkReturnPct)}`}>{pct(t.benchmarkReturnPct)}</span>, align: 'right' },
  { key: 'excess', header: 'Excess', cell: (t) => <span className={`font-mono ${toneClass(t.excessReturnPct)}`}>{pct(t.excessReturnPct)}</span>, align: 'right' },
  { key: 'pnl', header: 'Net $', cell: (t) => <span className={`font-mono ${toneClass(t.netPnl)}`}>{money(t.netPnl)}</span>, align: 'right' },
];

/** Newest-first slice of the signal log — the full table lives on /crypto/signals. */
const signalColumns: Array<Column<SignalRowView>> = [
  { key: 'ticker', header: 'Coin', cell: (s) => <span className="font-mono text-slate-soft">{s.ticker}</span>, sortValue: (s) => s.ticker },
  { key: 'signal', header: 'Signal', cell: (s) => <Badge tone={s.signal === 'BUY' ? 'pos' : 'neg'}>{s.signal}</Badge>, sortValue: (s) => s.signal },
  { key: 'conf', header: 'Confidence', cell: (s) => <ConfidenceBar value={s.confidence} />, sortValue: (s) => s.confidence },
  { key: 'price', header: 'Price', cell: (s) => <span className="font-mono">{Number(s.price).toLocaleString('en-US', { maximumFractionDigits: 6 })}</span>, align: 'right', sortValue: (s) => s.price },
  { key: 'target', header: 'Target', cell: (s) => <span className="font-mono">{Number(s.target).toLocaleString('en-US', { maximumFractionDigits: 6 })}</span>, align: 'right' },
  { key: 'exp', header: 'Exp. ret', cell: (s) => <span className={`font-mono ${toneClass(s.expectedReturnPct)}`}>{pct(s.expectedReturnPct)}</span>, align: 'right', sortValue: (s) => s.expectedReturnPct },
  { key: 'regime', header: 'Regime', cell: (s) => <span className="text-xs text-mist">{s.regime.toLowerCase()}</span> },
  { key: 'time', header: 'Published', cell: (s) => <span className="font-mono text-xs">{time(s.createdAt)}</span>, sortValue: (s) => s.createdAt },
];

export function OverviewPage() {
  const overview = useEndpoint<OverviewResponse>('/overview', getOverview);
  const portfolio = useEndpoint<PortfolioResponse>('/portfolio', getPortfolio);
  const signals = useEndpoint<SignalsResponse>('/signals?overview', () => getSignals({ limit: 100 }));

  const state = pageState(overview.data, overview.error, overview.reload, 'Loading the crypto book…');
  if (state) return state;

  const p = overview.data?.portfolio;
  const bench = overview.data?.benchmark;
  const stats = overview.data?.stats;
  const positions = overview.data?.positions ?? [];
  const recent = overview.data?.recentTrades ?? [];

  const allSignals = signals.data?.signals ?? [];
  const sigRows = allSignals.slice(0, 8);
  const buys = allSignals.filter((s) => s.signal === 'BUY').length;
  const sells = allSignals.length - buys;

  const points = (portfolio.data?.points ?? []).filter((pt) => Number.isFinite(pt.ts));
  const equitySeries = points.map((pt) => ({ x: pt.ts, y: pt.equity }));
  const benchSeries = points.map((pt) => ({ x: pt.ts, y: pt.benchmark }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Equity" value={money(p?.equity ?? null)} hint={`start ${money(p?.startCapital ?? null)}`} />
        <StatTile label="Cash" value={money(p?.cash ?? null)} hint={`${number(positions.length)} open positions`} />
        <StatTile label="Unrealized" value={money(p?.unrealized ?? null)} tone={toneFor(p?.unrealized ?? null)} hint="marked to last quote" />
        <StatTile label="Book return" value={pct(p?.returnPct ?? null)} tone={toneFor(p?.returnPct ?? null)} hint={`BTC ${pct(bench?.returnPct ?? null)}`} />
        <StatTile label="Signals" value={number(signals.data?.count ?? null)} hint={`${buys} buy · ${sells} sell`} />
      </div>

      <Card
        title="Latest signals"
        subtitle="newest first — the scanner publishes at most one signal per coin per day"
        actions={
          <Link to="/crypto/signals" className="text-xs text-mint hover:underline">
            View all signals &rarr;
          </Link>
        }
      >
        {!signals.data && !signals.error && <p className="py-4 text-sm text-mist">Loading signals…</p>}
        {signals.error && <p className="py-4 text-sm text-amber-soft">Signals unavailable: {signals.error}</p>}
        {signals.data && (
          <DataTable
            rows={sigRows}
            columns={signalColumns}
            rowKey={(s) => String(s.id)}
            label="latest crypto signals"
            empty={
              <p className="py-4 text-sm text-mist">
                No signals yet — the scan runs every 5 minutes, 24/7.
              </p>
            }
            defaultSort={{ key: 'time', dir: 'desc' }}
          />
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Equity curve" subtitle="paper book vs buy-and-hold BTC, same starting capital" className="lg:col-span-2">
          {points.length > 1 ? (
            <LineChart
              series={[
                { name: 'Crypto book', color: 'var(--color-mint, #4ade80)', points: equitySeries },
                { name: 'BTC benchmark', color: '#f59e0b', points: benchSeries },
              ]}
              ariaLabel="crypto equity versus BTC benchmark"
              valueFormat={(v) => money(v)}
            />
          ) : (
            <p className="py-6 text-center text-sm text-mist">
              The first snapshot lands within a minute of start-up — no curve yet.
            </p>
          )}
        </Card>

        <Card title="Paper ledger" subtitle="fee-inclusive: net of exchange fees on both sides">
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Closed" value={number(stats?.closed ?? 0)} />
            <StatTile label="Win rate" value={`${number(stats?.winRatePct ?? 0)}%`} hint={`${number(stats?.wins ?? 0)} wins`} />
            <StatTile label="Net P&L" value={money(stats?.netPnl ?? 0)} tone={toneFor(stats?.netPnl ?? 0)} />
            <StatTile label="Avg trade" value={pct(stats?.avgReturnPct ?? 0)} tone={toneFor(stats?.avgReturnPct ?? 0)} />
            <StatTile label="Fees paid" value={money(stats?.feesPaid ?? 0)} hint="entry + exit taker fees" />
            <StatTile label="Avg hold" value={`${number(stats?.avgHoldSessions ?? 0)}d`} />
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Benchmark" subtitle="BTC bought with the same starting capital" className="lg:col-span-1">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-mist">BTC price</dt><dd className="font-mono">{money(bench?.price ?? null)}</dd></div>
            <div className="flex justify-between"><dt className="text-mist">Start price</dt><dd className="font-mono">{money(bench?.startPrice ?? null)}</dd></div>
            <div className="flex justify-between"><dt className="text-mist">Benchmark equity</dt><dd className="font-mono">{money(bench?.equity ?? null)}</dd></div>
            <div className="flex justify-between"><dt className="text-mist">Return</dt><dd className={`font-mono ${toneClass(bench?.returnPct ?? null)}`}>{pct(bench?.returnPct ?? null)}</dd></div>
          </dl>
        </Card>

        <Card title="Open positions" subtitle="long-only spot — no leverage, no shorts" className="lg:col-span-2">
          <DataTable
            rows={positions}
            columns={positionColumns}
            rowKey={(p2) => String(p2.id)}
            label="open crypto positions"
            empty={<p className="py-4 text-sm text-mist">No open positions — the scanner opens one when conviction clears the floor.</p>}
            defaultSort={{ key: 'pnlPct', dir: 'desc' }}
          />
        </Card>
      </div>

      <Card title="Recent trades" subtitle="every close is fed back into lessons and fusion weights">
        <DataTable
          rows={recent}
          columns={tradeColumns}
          rowKey={(t) => String(t.id)}
          label="recent crypto trades"
          empty={<p className="py-4 text-sm text-mist">No closed trades yet — the first settle happens after a daily bar exits a position.</p>}
        />
      </Card>

      {overview.data?.snapshotAt && (
        <p className="text-[11px] text-mist">Snapshot {time(overview.data.snapshotAt)} · data refreshes every 60s while this tab is visible.</p>
      )}
    </div>
  );
}