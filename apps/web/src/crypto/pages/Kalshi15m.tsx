/**
 * Kalshi 15m — read-only console for the BTC 15-minute KXBTC15M engine.
 *
 * Five sections, each on its own endpoint of the existing /api/crypto tree
 * (publicly /pp/api/crypto/... behind the edge):
 *   1. Window & feed      GET /kalshi15m
 *   2. Fair value         GET /kalshi15m            + GET /kalshi15m/calibration
 *   3. Strategies SHADOW  GET /kalshi15m/signals    + status.shadowStrategies
 *   4. Paper              GET /kalshi15m/paper      (+ ?action=halt|resume)
 *   5. Recent signals     GET /kalshi15m/signals?limit=50
 *
 * Contract: no order path exists in this engine — the SHADOW and PAPER labels
 * are copied verbatim from the server and never softened. Money arrives in
 * CENTS (equityCents, netCents, dailyRealizedC, net_c) and is rendered in
 * dollars via money(cents / 100); a negative net is shown plainly, never as a
 * performance claim. Every payload is read defensively: the fixtures answer
 * '{}' for anything unknown, so each field defaults instead of assuming.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  getK15mCalibration,
  getK15mPaper,
  getK15mPaperAction,
  getK15mSignals,
  getK15mStatus,
} from '../api';
import type {
  K15mCalibrationResponse,
  K15mPaperResponse,
  K15mSignalsResponse,
  K15mSignalRow,
  K15mStatusResponse,
} from '../api';
import { REFRESH_MS, STATUS_REFRESH_MS, useEndpoint } from '../data';
import {
  Badge,
  Card,
  DataTable,
  ErrorState,
  Fields,
  Loading,
  StatTile,
  money,
  number,
  pctPlain,
  time,
} from '../../tradingusa/ui';
import type { Column } from '../../tradingusa/ui';

const SHADOW_LABEL = 'SHADOW — no order is ever placed from this engine';
const PAPER_LABEL = 'PAPER — simulated fills, no order path exists in this engine';

/** Strategy rows are listed in evaluation order, whatever the server sends. */
const STRATEGY_KEYS = [
  'A_LEADLAG',
  'B_MICRO',
  'C_PANICFADE',
  'D_MOMENTUM',
  'E_LATEFAV_HOLD',
  'F_MAKER',
] as const;

const pp = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)} pp`;

const frac4 = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(4);

/**
 * Sigmas are ~1e-5 — `number()`'s 2-decimal rounding would print a bare `0`,
 * a fake measurement. Never let a small-but-real value render as zero.
 */
const sci = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toExponential(2);

const secs = (ms: number | null | undefined): string =>
  ms === null || ms === undefined || !Number.isFinite(ms) ? '—' : `${Math.round(ms / 1000)}s`;

function RetryRow({ error, reload }: { error: string | null; reload: () => void }): ReactNode {
  if (!error) return null;
  return (
    <p role="alert" className="mb-3 border-l-2 border-amber-soft/60 bg-ink-900/70 py-2 pl-3 text-xs text-amber-soft">
      {error}{' '}
      <button type="button" onClick={reload} className="underline hover:text-mint">
        retry
      </button>
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* 1 + 2 — window/feed and fair value (both read GET /kalshi15m)       */
/* ------------------------------------------------------------------ */

function WindowFeed({ status }: { status: ReturnType<typeof useEndpoint<K15mStatusResponse>> }) {
  const st = status.data;
  if (st === undefined) {
    return status.error ? <ErrorState message={status.error} onRetry={status.reload} /> : <Loading label="Loading Kalshi 15m status…" />;
  }
  if (st.enabled === false) {
    return (
      <Card title="Window & feed" subtitle={st.note ?? 'K15mRuntime is not constructed in this process'}>
        <p className="text-sm text-mist">Engine off — no window, book or feed counters are available.</p>
      </Card>
    );
  }

  const win = st.window ?? {};
  const sock = st.socket ?? {};
  const book = st.book ?? {};
  const counts = st.counters ?? {};
  const cadence = st.cadence ?? {};
  const live = sock.live === true && sock.stale !== true;

  return (
    <Card
      title="Window & feed"
      subtitle={`${st.series ?? 'KXBTC15M'} · websocket feed of the live 15-minute market`}
      actions={<Badge tone={live ? 'pos' : 'warn'}>{live ? 'LIVE' : 'STALE'}</Badge>}
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Phase" value={win.phase ?? '—'} hint={win.eventTicker ?? '—'} tone={live ? 'pos' : 'warn'} />
        <StatTile label="Closes in" value={secs(win.msToClose)} hint={`strike ${number(win.strike ?? null)}`} />
        <StatTile label="Best bid / ask" value={`${frac4(book.bestBid)} / ${frac4(book.bestAsk)}`} hint={`spread ${frac4(book.spread)} · ${book.trusted ? 'book trusted' : 'book untrusted'}`} />
        <StatTile label="Socket" value={sock.live ? 'websocket' : 'down'} hint={`staleness ${number(sock.stalenessMs ?? null)}ms · ${number(sock.errors ?? 0)} errors`} tone={live ? 'pos' : 'neg'} />
      </div>

      <Fields
        items={[
          { label: 'Market ticker', value: <span className="font-mono text-xs">{win.marketTicker ?? '—'}</span> },
          { label: 'Window source', value: win.source ?? '—' },
          { label: 'Closes at', value: time(win.closeTs ?? null) },
          { label: 'Expires at', value: time(win.expireTs ?? null) },
          { label: 'Book levels', value: `${number(book.levels?.bids ?? null)} bids · ${number(book.levels?.asks ?? null)} asks` },
          { label: 'Imbalance / OFI', value: `${frac4(book.imbalance)} / ${frac4(book.ofi)}` },
          { label: 'Book deltas in window', value: number(book.deltasInWindow ?? null) },
          { label: 'Trades 1s / 5s', value: `${number(book.trades1s ?? null)} / ${number(book.trades5s ?? null)}` },
          { label: 'Samples persisted', value: number(counts.samples ?? null) },
          { label: 'Sequence gaps', value: number(counts.seqGaps ?? null) },
          { label: 'Discovers / rollovers', value: `${number(counts.discovers ?? null)} / ${number(counts.rollOvers ?? null)}` },
          { label: 'Cadence', value: `sample ${number(cadence.sampleMs ?? null)}ms · discover ${number(cadence.discoverMs ?? null)}ms · stale ${number(cadence.staleMs ?? null)}ms` },
        ]}
      />
      {sock.lastError && <p className="mt-3 text-xs text-amber-soft">Last socket error: {sock.lastError}</p>}
    </Card>
  );
}

function FairValue({
  status,
  calibration,
}: {
  status: ReturnType<typeof useEndpoint<K15mStatusResponse>>;
  calibration: ReturnType<typeof useEndpoint<K15mCalibrationResponse>>;
}) {
  const fair = status.data?.fairValue;
  const cal = calibration.data;
  const sigmaPolicy = status.data?.sigmaPolicy;

  return (
    <Card
      title="Fair value & calibration"
      subtitle="model probability vs the book — an approximation, never a settlement value"
    >
      <RetryRow error={status.error} reload={status.reload} />
      {status.data === undefined ? (
        <Loading label="Loading fair value…" />
      ) : status.data.enabled === false ? (
        <p className="text-sm text-mist">{status.data.note ?? 'Engine off — no fair value is computed.'}</p>
      ) : fair === undefined ? (
        <p className="text-sm text-mist">No fair value in the status payload.</p>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Reference"
              value={fair.reference ?? '—'}
              hint={`${fair.approx ?? '—'} spot · settlement_reference is never assumed`}
              tone={fair.reference === 'APPROXIMATION' ? 'warn' : 'info'}
            />
            <StatTile label="Model p(YES)" value={frac4(fair.pYes)} hint={`book mid ${frac4(fair.impliedMid)}`} />
            <StatTile label="Edge" value={pp(fair.edgePp)} hint={fair.reason ? `reason: ${fair.reason}` : 'p(YES) − implied mid'} tone={fair.edgePp != null && fair.edgePp > 0 ? 'pos' : 'neutral'} />
            <StatTile label="Sigma source" value={fair.sigmaSource ?? sigmaPolicy?.source ?? '—'} hint={`window ${number(fair.sigmaWindowSec ?? null)}s · realized ${sci(fair.sigmaRealized ?? null)}`} />
          </div>
          <Fields
            items={[
              { label: 'Spot (approximation)', value: number(fair.spot ?? null) },
              { label: 'Fair sigma', value: fair.sigma === null || fair.sigma === undefined ? '—' : fair.sigma.toExponential(2) },
              { label: 'Implied mid', value: frac4(fair.impliedMid) },
              { label: 'Fair reason', value: fair.reason ?? '—' },
            ]}
          />
        </>
      )}

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-mist">Calibration</h3>
      <RetryRow error={calibration.error} reload={calibration.reload} />
      {calibration.data === undefined ? (
        <Loading label="Loading calibration…" />
      ) : cal?.sigma === undefined || cal?.edge === undefined ? (
        <p className="mt-2 text-sm text-mist">{cal?.note ?? 'No calibration rows yet.'}</p>
      ) : (
        <>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Realized sigma (median)" value={sci(cal.sigma.realizedMedian ?? null)} hint={sci(cal.sigma.impliedMedian ?? null) + " implied"} />
            <StatTile
              label="Implied / realized"
              value={number(cal.sigma.impliedOverRealizedMedian ?? null)}
              hint={`${number(cal.sigma.pairedSamples ?? null)} paired samples`}
              tone="warn"
            />
            <StatTile label="Edge median" value={pp(cal.edge.medianPp)} />
            <StatTile label="Edge |p95|" value={pp(cal.edge.p95AbsPp)} hint={`${pctPlain((cal.edge.shareOver2Pp ?? 0) * 100)} of samples over 2 pp`} />
          </div>
          <p className="mt-3 text-[11px] leading-4 text-mist">{cal.note}</p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 3 — strategies (shadow)                                             */
/* ------------------------------------------------------------------ */

function Strategies({
  status,
  signals,
}: {
  status: ReturnType<typeof useEndpoint<K15mStatusResponse>>;
  signals: ReturnType<typeof useEndpoint<K15mSignalsResponse>>;
}) {
  const shadow = status.data?.shadowStrategies;
  const per = shadow?.shadowStrategies ?? {};
  const summary = signals.data?.summary;
  const skipReasons = Object.entries(summary?.bySkipReason ?? {}).sort((a, b) => b[1] - a[1]);
  const strategyEnabled = (key: string): boolean | undefined =>
    shadow?.enabled?.[key] ?? per[key]?.evaluated !== undefined;

  const rows = STRATEGY_KEYS.map((key) => {
    const counts = per[key] ?? {};
    const evaluated = counts.evaluated ?? 0;
    const traded = counts.traded ?? 0;
    return { key, evaluated, traded, skipped: Math.max(0, evaluated - traded) };
  });

  return (
    <Card title="Strategies" subtitle={SHADOW_LABEL}>
      <RetryRow error={signals.error} reload={signals.reload} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Mode" value={shadow?.mode ?? signals.data?.mode?.slice(0, 6) ?? 'SHADOW'} hint="no order is ever placed from this engine" tone="warn" />
        <StatTile label="Evaluated" value={number(summary?.trades !== undefined ? (summary.trades ?? 0) + (summary.skips ?? 0) : undefined)} hint={`${number(summary?.trades ?? null)} taken · ${number(summary?.skips ?? null)} skipped in ${number(summary?.window?.rows ?? null)} rows`} />
        <StatTile label="Taken (verdict TRADE)" value={number(summary?.trades ?? null)} hint={`median net ${pp(summary?.tradeNetPpMedian ?? null)}`} />
        <StatTile label="Skip reasons" value={number(skipReasons.length)} hint="top: see table below" />
      </div>

      <DataTable
        rows={rows}
        columns={[
          { key: 'strategy', header: 'Strategy', cell: (r) => <span className="font-mono text-xs text-slate-soft">{r.key}</span> },
          {
            key: 'enabled',
            header: 'Enabled',
            cell: (r) => <Badge tone={strategyEnabled(r.key) ? 'pos' : 'neutral'}>{strategyEnabled(r.key) ? 'ON' : 'OFF'}</Badge>,
          },
          { key: 'evaluated', header: 'Evaluated', cell: (r) => <span className="font-mono text-xs">{number(r.evaluated)}</span>, align: 'right' },
          { key: 'traded', header: 'TRADE verdicts', cell: (r) => <span className="font-mono text-xs text-mint">{number(r.traded)}</span>, align: 'right' },
          { key: 'skipped', header: 'SKIP verdicts', cell: (r) => <span className="font-mono text-xs text-mist">{number(r.skipped)}</span>, align: 'right' },
        ]}
        rowKey={(r) => r.key}
        label="kalshi 15m shadow strategies"
        empty={<p className="py-4 text-sm text-mist">No strategy counters yet.</p>}
      />

      {skipReasons.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-mist">Skip reasons (last {number(summary?.window?.rows ?? null)} evaluations)</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {skipReasons.map(([reason, n]) => (
              <span key={reason} className="rounded-full border border-line bg-ink-800 px-2 py-0.5 font-mono text-[11px] text-mist" title={reason}>
                {reason} · {n}
              </span>
            ))}
          </div>
        </div>
      )}
      {summary?.note && <p className="mt-3 text-[11px] leading-4 text-mist">{summary.note}</p>}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 4 — paper execution                                                 */
/* ------------------------------------------------------------------ */

function Paper({ paper, reloadAll }: { paper: ReturnType<typeof useEndpoint<K15mPaperResponse>>; reloadAll: () => void }) {
  const [busy, setBusy] = useState<'halt' | 'resume' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (action: 'halt' | 'resume'): Promise<void> => {
    setBusy(action);
    setActionError(null);
    try {
      await getK15mPaperAction(action);
      reloadAll();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const p = paper.data;
  const closed = p?.closed;
  const risk = p?.risk;
  const halt = p?.halt;
  const halted = halt?.manual === true || halt?.auto === true;

  return (
    <Card
      title="Paper execution"
      subtitle={PAPER_LABEL}
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void act('halt')}
            disabled={busy !== null || p?.enabled === false}
            className="rounded-md border border-amber-soft/50 bg-amber-soft/10 px-3 py-1 text-xs text-amber-soft hover:bg-amber-soft/20 disabled:opacity-50"
          >
            {busy === 'halt' ? 'Halting…' : 'Halt'}
          </button>
          <button
            type="button"
            onClick={() => void act('resume')}
            disabled={busy !== null || p?.enabled === false}
            className="rounded-md border border-mint/50 bg-mint/10 px-3 py-1 text-xs text-mint hover:bg-mint/20 disabled:opacity-50"
          >
            {busy === 'resume' ? 'Resuming…' : 'Resume'}
          </button>
        </div>
      }
    >
      <RetryRow error={paper.error} reload={paper.reload} />
      {actionError && <p role="alert" className="mb-3 text-xs text-amber-soft">Paper action failed: {actionError}</p>}

      {p === undefined ? (
        <Loading label="Loading paper ledger…" />
      ) : p.enabled === false ? (
        <p className="text-sm text-mist">Paper engine is off (K15mRuntime not constructed in this process).</p>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Paper equity"
              value={money((p.equityCents ?? 0) / 100)}
              hint={`bankroll ${money((p.config?.bankrollCents ?? 0) / 100)} · simulated`}
            />
            <StatTile
              label="Halt state"
              value={halted ? 'HALTED' : 'RUNNING'}
              hint={`${halt?.manual ? 'manual' : ''}${halt?.manual && halt?.auto ? ' + ' : ''}${halt?.auto ? `auto: ${halt.reason ?? '—'}` : ''}${!halted ? `${number(halt?.halts ?? 0)} halt(s) so far` : ''}`.trim() || 'no halt'}
              tone={halted ? 'neg' : 'pos'}
            />
            <StatTile
              label="Daily realized"
              value={money((risk?.dailyRealizedC ?? 0) / 100)}
              hint={`${number(risk?.openPositions ?? 0)} open · cost ${money((risk?.openCostC ?? 0) / 100)}`}
              tone={(risk?.dailyRealizedC ?? 0) < 0 ? 'neg' : 'pos'}
            />
            <StatTile
              label="Closed net"
              value={money((closed?.netCents ?? 0) / 100)}
              hint={`${number(closed?.trades ?? 0)} trades · fees ${money((closed?.feesCents ?? 0) / 100)}`}
              tone={(closed?.netCents ?? 0) < 0 ? 'neg' : 'pos'}
            />
          </div>

          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Win rate" value={pctPlain(closed?.winRatePct ?? null)} hint={`${number(closed?.wins ?? null)} wins of ${number(closed?.trades ?? null)} — sample size travels with the rate`} />
            <StatTile label="Entries / rejections" value={`${number(p.counters?.entries ?? 0)} / ${number(p.counters?.rejected ?? 0)}`} hint={`${number(p.counters?.exits ?? 0)} exits · ${number(p.counters?.halts ?? 0)} halts`} />
            <StatTile label="Open positions" value={number(risk?.openPositions ?? 0)} hint={risk?.blockedBy ? `blocked by ${risk.blockedBy}` : 'no gate blocking'} />
            <StatTile label="Kill switch" value={p.config?.killSwitch ? 'ON' : 'off'} hint={`min edge ${number(p.config?.minNetPp ?? null)} pp · hold ${number(p.config?.holdSec ?? null)}s`} tone={p.config?.killSwitch ? 'neg' : 'neutral'} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-mist">Exit reasons</h3>
              <DataTable
                rows={(closed?.byExitReason ?? []).map((x) => ({ ...x }))}
                columns={[
                  { key: 'r', header: 'Exit', cell: (r) => <span className="font-mono text-xs text-slate-soft">{r.r}</span> },
                  { key: 'n', header: 'Trades', cell: (r) => <span className="font-mono text-xs">{number(r.n)}</span>, align: 'right' },
                ]}
                rowKey={(r) => r.r}
                label="paper exit reasons"
                empty={<p className="py-3 text-sm text-mist">No closed paper trades yet.</p>}
              />
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-mist">By strategy</h3>
              <DataTable
                rows={(p.byStrategy ?? []).map((x) => ({ ...x }))}
                columns={[
                  { key: 's', header: 'Strategy', cell: (r) => <span className="font-mono text-xs text-slate-soft">{r.strategy}</span> },
                  { key: 't', header: 'Trades', cell: (r) => <span className="font-mono text-xs">{number(r.trades)}</span>, align: 'right' },
                  {
                    key: 'net',
                    header: 'Net',
                    cell: (r) => (
                      <span className={`font-mono text-xs ${(r.net_c ?? 0) < 0 ? 'text-danger' : 'text-mint'}`}>{money((r.net_c ?? 0) / 100)}</span>
                    ),
                    align: 'right',
                  },
                ]}
                rowKey={(r) => r.strategy}
                label="paper by strategy"
                empty={<p className="py-3 text-sm text-mist">No strategy has traded yet.</p>}
              />
            </div>
          </div>

          {Object.keys(p.rejects ?? {}).length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-mist">Rejections</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(p.rejects ?? {}).map(([k, n]) => (
                  <span key={k} className="rounded-full border border-line bg-ink-800 px-2 py-0.5 font-mono text-[11px] text-mist">
                    {k} · {n}
                  </span>
                ))}
              </div>
            </div>
          )}

          {(p.open ?? []).length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-mist">Open paper positions</h3>
              <DataTable
                rows={p.open ?? []}
                columns={[
                  { key: 'm', header: 'Market', cell: (r) => <span className="font-mono text-xs text-slate-soft">{r.eventTicker ?? '—'}</span> },
                  { key: 's', header: 'Strategy', cell: (r) => <span className="font-mono text-xs">{r.strategy ?? '—'}</span> },
                  { key: 'side', header: 'Side', cell: (r) => <Badge tone="info">{r.side ?? '—'}</Badge> },
                  { key: 'qty', header: 'Qty', cell: (r) => <span className="font-mono text-xs">{number(r.qty ?? null)}</span>, align: 'right' },
                  { key: 'entry', header: 'Entry', cell: (r) => <span className="font-mono text-xs">{frac4(r.entryPrice ?? null)}</span>, align: 'right' },
                  { key: 'ts', header: 'Entry time', cell: (r) => <span className="font-mono text-xs">{time(r.entryTs ?? null)}</span>, align: 'right' },
                ]}
                rowKey={(r) => `${r.eventTicker ?? 'open'}-${r.entryTs ?? 0}`}
                label="open paper positions"
                empty={<p className="py-3 text-sm text-mist">No open positions.</p>}
              />
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 5 — recent signals                                                  */
/* ------------------------------------------------------------------ */

const signalColumns: Array<Column<K15mSignalRow>> = [
  { key: 'ts', header: 'Time', cell: (s) => <span className="font-mono text-xs">{time(s.ts)}</span>, sortValue: (s) => s.ts },
  { key: 'strategy', header: 'Strategy', cell: (s) => <span className="font-mono text-xs text-slate-soft">{s.strategy ?? '—'}</span>, sortValue: (s) => s.strategy ?? '' },
  {
    key: 'verdict',
    header: 'Verdict',
    cell: (s) => <Badge tone={s.verdict === 'TRADE' ? 'pos' : 'neutral'}>{s.verdict ?? '—'}</Badge>,
    sortValue: (s) => s.verdict ?? '',
  },
  { key: 'side', header: 'Side', cell: (s) => (s.side ? <Badge tone="info">{s.side}</Badge> : <span className="text-mist">—</span>) },
  {
    key: 'net',
    header: 'Net',
    cell: (s) => <span className="font-mono text-xs">{pp(s.net_pp ?? null)}</span>,
    align: 'right',
    sortValue: (s) => s.net_pp ?? null,
  },
  { key: 'skip', header: 'Skip reason', cell: (s) => <span className="text-[11px] text-mist">{s.skip_reason ?? '—'}</span> },
  {
    key: 'reasons',
    header: 'Reasons',
    cell: (s) => {
      const text = s.reasons ?? '';
      return (
        <span className="text-[11px] text-mist" title={text}>
          {text.length > 120 ? `${text.slice(0, 120)}…` : text || '—'}
        </span>
      );
    },
  },
];

function RecentSignals({ signals }: { signals: ReturnType<typeof useEndpoint<K15mSignalsResponse>> }) {
  const rows = signals.data?.signals ?? [];
  return (
    <Card
      title="Recent signals"
      subtitle="last 50 evaluations — TRADE and SKIP verdicts alike are recorded"
      actions={signals.data?.count !== undefined ? <Badge tone="neutral">{signals.data.count} rows</Badge> : undefined}
    >
      <RetryRow error={signals.error} reload={signals.reload} />
      {signals.data === undefined ? (
        <Loading label="Loading signals…" />
      ) : (
        <DataTable
          rows={rows}
          columns={signalColumns}
          rowKey={(s) => String(s.id)}
          label="kalshi 15m recent signals"
          empty={<p className="py-4 text-sm text-mist">No signals recorded yet.</p>}
          defaultSort={{ key: 'ts', dir: 'desc' }}
        />
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export function Kalshi15mPage() {
  const status = useEndpoint<K15mStatusResponse>('/kalshi15m', getK15mStatus, STATUS_REFRESH_MS);
  const calibration = useEndpoint<K15mCalibrationResponse>('/kalshi15m/calibration?limit=2000', () => getK15mCalibration(2000), REFRESH_MS);
  const strategySummary = useEndpoint<K15mSignalsResponse>(
    '/kalshi15m/signals?limit=1&summary_limit=2000',
    () => getK15mSignals({ limit: 1, summaryLimit: 2_000 }),
    REFRESH_MS,
  );
  const recent = useEndpoint<K15mSignalsResponse>('/kalshi15m/signals?limit=50', () => getK15mSignals({ limit: 50 }), REFRESH_MS);
  const paper = useEndpoint<K15mPaperResponse>('/kalshi15m/paper', getK15mPaper, REFRESH_MS);

  return (
    <div className="space-y-5">
      <WindowFeed status={status} />
      <FairValue status={status} calibration={calibration} />
      <Strategies status={status} signals={strategySummary} />
      <Paper paper={paper} reloadAll={() => { paper.reload(); status.reload(); }} />
      <RecentSignals signals={recent} />
    </div>
  );
}