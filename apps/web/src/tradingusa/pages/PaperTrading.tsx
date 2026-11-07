/**
 * Paper Trading — the P explainer straight from GET /settings → locked
 * (executionMode, realMoneyEnabled, broker adapters), open positions with
 * excursion/risk columns, closed trades with predicted-vs-actual paired
 * bars, and the open/closed counts.
 */

import { getSettings, getTrades } from '../api';
import type { Position, SettingsResponse, TradeRow, TradesResponse } from '../api';
import { Link, useEndpoint } from '../data';
import {
  Badge,
  Card,
  DataTable,
  ErrorState,
  Loading,
  PairedBars,
  dateText,
  flex,
  money,
  number,
  pct,
  time,
  toneClass,
} from '../ui';
import type { Column } from '../ui';

const OPEN_COLUMNS: Array<Column<Position>> = [
  { key: 'ticker', header: 'Ticker', sortValue: (r: Position) => r.ticker, cell: (r: Position) => <span className="font-mono font-semibold text-mint">{r.ticker}</span> },
  { key: 'qty', header: 'Qty', align: 'right' as const, sortValue: (r: Position) => r.qty, cell: (r: Position) => <span className="font-mono">{number(r.qty)}</span> },
  { key: 'entry', header: 'Entry', align: 'right' as const, sortValue: (r: Position) => r.entryPrice, cell: (r: Position) => <span className="font-mono">{money(r.entryPrice)}</span> },
  { key: 'current', header: 'Current price', align: 'right' as const, sortValue: (r: Position) => r.currentPrice, cell: (r: Position) => <span className="font-mono">{money(r.currentPrice)}</span> },
  { key: 'unreal', header: 'Unrealized P&L', align: 'right' as const, sortValue: (r: Position) => r.unrealizedPnl, cell: (r: Position) => <span className={`font-mono ${toneClass(r.unrealizedPnl)}`}>{money(r.unrealizedPnl)}</span> },
  { key: 'ret', header: 'Return %', align: 'right' as const, sortValue: (r: Position) => r.returnPct, cell: (r: Position) => <span className={`font-mono ${toneClass(r.returnPct)}`}>{pct(r.returnPct)}</span> },
  { key: 'target', header: 'Target', align: 'right' as const, cell: (r: Position) => <span className="font-mono">{money(r.target)}</span> },
  { key: 'stop', header: 'Stop', align: 'right' as const, cell: (r: Position) => <span className="font-mono">{money(r.stop)}</span> },
  { key: 'dTarget', header: 'Distance to target', align: 'right' as const, cell: (r: Position) => <span className="font-mono text-mint">{pct(r.distanceToTargetPct ?? null)}</span> },
  { key: 'dStop', header: 'Distance to stop', align: 'right' as const, cell: (r: Position) => <span className="font-mono text-danger">{pct(r.distanceToStopPct ?? null)}</span> },
  { key: 'days', header: 'Days held', align: 'right' as const, sortValue: (r: Position) => r.daysHeld ?? null, cell: (r: Position) => <span className="font-mono">{number(r.daysHeld ?? null)}</span> },
  { key: 'mfe', header: 'MFE', align: 'right' as const, cell: (r: Position) => <span className="font-mono text-mint">{pct(r.maxFavorableExcursion ?? null)}</span> },
  { key: 'mae', header: 'MAE', align: 'right' as const, cell: (r: Position) => <span className="font-mono text-danger">{pct(r.maxAdverseExcursion ?? null)}</span> },
  { key: 'thesis', header: 'Thesis status', cell: (r: Position) => <Badge tone={r.thesisStatus === 'INTACT' ? 'pos' : r.thesisStatus === 'BROKEN' ? 'neg' : 'warn'}>{r.thesisStatus ?? '—'}</Badge> },
];

export function PaperTradingPage() {
  const settings = useEndpoint<SettingsResponse>('/settings', getSettings);
  const closed = useEndpoint<TradesResponse>('/trades?status=closed', () => getTrades({ status: 'closed' }));
  const open = useEndpoint<TradesResponse>('/trades?status=open', () => getTrades({ status: 'open' }));

  const locked = settings.data?.locked;
  const counts = closed.data?.counts;

  return (
    <div className="space-y-4">
      {/* PAPER-ONLY explainer from the server's own locked config */}
      <Card title="Execution guard — paper only" className="border-amber-soft/40">
        <div className="rounded-md border border-amber-soft/40 bg-amber-soft/10 px-3 py-2 font-mono text-xs uppercase tracking-wide text-amber-soft">
          PAPER TRADING · NO REAL MONEY IS BEING USED
        </div>
        {settings.data === undefined ? (
          <p className="mt-2 text-xs text-mist">{settings.error ? `locked settings unavailable: ${settings.error}` : 'Reading locked settings…'}</p>
        ) : (
          <div className="mt-3 grid gap-x-8 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex justify-between gap-2 border-b border-line/60 py-1">
              <span className="text-mist">executionMode</span>
              <span className="font-mono text-amber-soft">{locked?.executionMode ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-2 border-b border-line/60 py-1">
              <span className="text-mist">realMoneyEnabled</span>
              <span className="font-mono text-mint">{String(locked?.realMoneyEnabled ?? false)}</span>
            </div>
            <div className="flex justify-between gap-2 border-b border-line/60 py-1">
              <span className="text-mist">broker adapters</span>
              <span className="font-mono text-slate-soft">{(locked?.brokerAdapters ?? []).join(', ') || '—'}</span>
            </div>
            <div className="flex justify-between gap-2 border-b border-line/60 py-1">
              <span className="text-mist">RobinhoodAdapter</span>
              <span className="font-mono text-mist">interface prepared, NOT implemented, NOT active</span>
            </div>
          </div>
        )}
        <p className="mt-2 text-xs text-mist">
          All fills below are simulated against delayed quotes. There is no path from this screen to a live order,
          transfer, deposit or withdrawal.
        </p>
      </Card>

      {/* counts */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card title="Open positions">
          <span className="font-mono text-2xl text-slate-soft">{number(counts?.open ?? open.data?.counts?.open ?? null)}</span>
        </Card>
        <Card title="Closed trades">
          <span className="font-mono text-2xl text-slate-soft">{number(counts?.closed ?? null)}</span>
        </Card>
        <Card title="Forecast quality">
          <span className="font-mono text-2xl text-slate-soft">
            {(closed.data?.trades ?? []).filter((t) => t.predictedReturnPct !== null && t.predictedReturnPct !== undefined).length} /{' '}
            {number((closed.data?.trades ?? []).length)}
          </span>
          <p className="mt-1 text-[11px] text-mist">closed trades carrying a prediction</p>
        </Card>
      </div>

      {/* open positions */}
      <Card title="Open positions" subtitle="Live paper book — excursion and distance columns update with each quote refresh.">
        {open.data === undefined ? (
          open.error ? (
            <ErrorState message={open.error} onRetry={open.reload} />
          ) : (
            <Loading label="Loading open positions…" />
          )
        ) : (
          <DataTable
            label="Open positions"
            rows={open.data.trades ?? []}
            columns={OPEN_COLUMNS}
            rowKey={(r) => r.id}
            empty={<p className="py-4 text-center text-xs text-mist">No open paper positions.</p>}
          />
        )}
      </Card>

      {/* closed trades */}
      <Card title="Closed trades" subtitle="Predicted vs actual, benchmark and excess — forecast honesty is the point.">
        {closed.data === undefined ? (
          closed.error ? (
            <ErrorState message={closed.error} onRetry={closed.reload} />
          ) : (
            <Loading label="Loading closed trades…" />
          )
        ) : (
          <DataTable
            label="Closed trades"
            rows={closed.data.trades ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: 'ticker', header: 'Ticker', cell: (r: TradeRow) => <Link to={`/tradingusa/stocks/${r.ticker}`} className="font-mono font-semibold text-mint hover:underline">{r.ticker}</Link> },
              { key: 'entry', header: 'Entry', cell: (r: TradeRow) => <span className="font-mono text-xs">{time(r.entryTs)}</span> },
              { key: 'exit', header: 'Exit', cell: (r: TradeRow) => <span className="font-mono text-xs">{time(r.exitTs ?? null)}</span> },
              { key: 'exitPrice', header: 'Exit price', align: 'right', cell: (r: TradeRow) => <span className="font-mono">{money(r.exitPrice ?? null)}</span> },
              { key: 'net', header: 'Net P&L', align: 'right', cell: (r: TradeRow) => <span className={`font-mono ${toneClass(r.netPnl ?? null)}`}>{money(r.netPnl ?? null)}</span> },
              { key: 'predicted', header: 'Predicted return', align: 'right', cell: (r: TradeRow) => <span className="font-mono text-violet-soft">{pct(r.predictedReturnPct ?? null)}</span> },
              { key: 'actual', header: 'Actual return', align: 'right', cell: (r: TradeRow) => <span className={`font-mono ${toneClass(r.actualReturnPct ?? null)}`}>{pct(r.actualReturnPct ?? null)}</span> },
              { key: 'error', header: 'Prediction error', align: 'right', cell: (r: TradeRow) => <span className="font-mono text-amber-soft">{pct(r.predictionErrorPct ?? null)}</span> },
              { key: 'bench', header: 'Benchmark', align: 'right', cell: (r: TradeRow) => <span className="font-mono text-mist">{pct(r.benchmarkReturnPct ?? null)}</span> },
              { key: 'excess', header: 'Excess', align: 'right', cell: (r: TradeRow) => <span className={`font-mono ${toneClass(r.excessReturnPct ?? null)}`}>{pct(r.excessReturnPct ?? null)}</span> },
              { key: 'gross', header: 'Gross P&L', align: 'right', cell: (r: TradeRow) => <span className={`font-mono ${toneClass(r.grossPnl ?? null)}`}>{money(r.grossPnl ?? null)}</span> },
              { key: 'mfe', header: 'MFE', align: 'right', cell: (r: TradeRow) => <span className="font-mono text-mint">{pct(r.mfe ?? null)}</span> },
              { key: 'mae', header: 'MAE', align: 'right', cell: (r: TradeRow) => <span className="font-mono text-danger">{pct(r.mae ?? null)}</span> },
              { key: 'sv', header: 'Strategy version', cell: (r: TradeRow) => <span className="font-mono text-[11px] text-mist">{r.strategyVersion ?? '—'}</span> },
              { key: 'reason', header: 'Exit reason', cell: (r: TradeRow) => <Badge tone={r.exitReason === 'TARGET' ? 'pos' : r.exitReason === 'STOP' ? 'neg' : 'neutral'}>{r.exitReason ?? '—'}</Badge> },
              {
                key: 'bars',
                header: 'Predicted vs actual',
                cell: (r: TradeRow) => (
                  <div className="min-w-[180px]">
                    <PairedBars
                      leftLabel="Predicted"
                      leftValue={r.predictedReturnPct ?? null}
                      rightLabel="Actual"
                      rightValue={r.actualReturnPct ?? null}
                    />
                  </div>
                ),
              },
            ]}
            empty={<p className="py-4 text-center text-xs text-mist">No closed paper trades yet.</p>}
          />
        )}
      </Card>

      <p className="text-[11px] text-mist">
        Last refresh {dateText(new Date().toISOString())} · counts from GET /trades · open book from{' '}
        <span className="font-mono">GET /trades?status=open</span> {flex(open.data?.counts ?? null)}
      </p>
    </div>
  );
}