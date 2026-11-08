/**
 * System — proof the 24/7 loop is alive: provider/stream state, universe and
 * data counts, every job's last status/duration, recent errors, and a manual
 * "run one cycle now" button (it runs exactly what the timer would run).
 */

import { useState } from 'react';
import { getJobs, getShadow, getStatus, runCycle } from '../api';
import type { JobsResponse, RunResponse, ShadowResponse, StatusResponse } from '../api';
import { useEndpoint } from '../data';
import {
  Badge,
  Card,
  DataTable,
  ErrorState,
  Loading,
  StatTile,
  dateText,
  number,
  time,
} from '../../tradingusa/ui';
import type { Column } from '../../tradingusa/ui';
import type { JobRow } from '../api';

const jobColumns: Array<Column<JobRow>> = [
  { key: 'name', header: 'Job', cell: (j) => <span className="font-mono text-xs text-slate-soft">{j.name}</span>, sortValue: (j) => j.name },
  { key: 'status', header: 'Last status', cell: (j) => <Badge tone={j.last_status === 'ERROR' ? 'neg' : 'pos'}>{j.last_status ?? '—'}</Badge> },
  { key: 'duration', header: 'Duration', cell: (j) => <span className="font-mono text-xs">{number(j.duration_ms ?? null)}ms</span>, align: 'right' },
  { key: 'runs', header: 'Runs', cell: (j) => <span className="font-mono text-xs">{number(j.runs ?? null)}</span>, align: 'right', sortValue: (j) => j.runs ?? 0 },
  { key: 'last', header: 'Last run', cell: (j) => <span className="font-mono text-xs">{j.last_run ? time(j.last_run) : '—'}</span>, align: 'right', sortValue: (j) => j.last_run ?? 0 },
  {
    key: 'error',
    header: 'Error',
    cell: (j) => <span className="text-[11px] text-mist">{j.last_error ? String(j.last_error).slice(0, 120) : '—'}</span>,
  },
];

export function SystemPage() {
  const status = useEndpoint<StatusResponse>('/status', getStatus);
  const jobs = useEndpoint<JobsResponse>('/jobs', getJobs);
  const shadow = useEndpoint<ShadowResponse>('/shadow', getShadow);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  if (status.data === undefined) {
    return status.error ? <ErrorState message={status.error} onRetry={status.reload} /> : <Loading label="Loading status…" />;
  }
  // unknown/partial payloads must survive — default every block instead of
  // assuming the server shape (see the crypto fixtures' '{}' contract)
  const raw = status.data;
  const s = {
    executionMode: raw.executionMode ?? 'PAPER_ONLY',
    portfolioKind: raw.portfolioKind ?? 'CRYPTO_SPOT',
    session: raw.session ?? 'MARKET_OPEN',
    provider: raw.provider ?? { name: '—', status: 'UNAVAILABLE', lastUpdate: 0, lastLatencyMs: 0, lastError: null },
    stream: raw.stream ?? { live: false, symbols: 0 },
    universe: raw.universe ?? { members: 0, active: 0, pinned: [], ranked: [], changes: [] },
    counts: raw.counts ?? { quotes: 0, bars: 0, signals: 0, openPositions: 0, closedTrades: 0 },
    recentErrors: raw.recentErrors ?? [],
  };

  const onRun = async (): Promise<void> => {
    setRunning(true);
    setRunError(null);
    try {
      const out: RunResponse = await runCycle();
      setResult(
        `cycle done · ${out.signalsCreated} new signal(s) · equity ${out.snapshot.equity.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
      );
      jobs.reload();
      status.reload();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Provider" value={s.provider.name} hint={s.provider.lastError ?? `latency ${s.provider.lastLatencyMs}ms`} tone={s.provider.status === 'CONNECTED' ? 'pos' : 'warn'} />
        <StatTile label="Transport" value={s.stream.live ? 'websocket' : 'rest poll'} hint={`${s.stream.symbols} symbols subscribed`} tone={s.stream.live ? 'pos' : 'info'} />
        <StatTile label="Universe" value={`${s.universe.active} coins`} hint={`${s.universe.pinned.length} pinned + ${s.universe.ranked.length} ranked`} />
        <StatTile label="Data" value={`${number(s.counts.bars)} bars`} hint={`${number(s.counts.quotes)} quotes · ${number(s.counts.signals)} signals`} />
        <StatTile label="Execution" value={s.executionMode} hint={`${s.portfolioKind} · ${s.session}`} tone="warn" />
      </div>

      <Card
        title="Jobs"
        subtitle="each job records its own last status — this is how you tell the 24/7 loop is alive"
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onRun()}
              disabled={running}
              className="rounded-md border border-mint/50 bg-mint/10 px-3 py-1 text-xs text-mint hover:bg-mint/20 disabled:opacity-50"
            >
              {running ? 'Running…' : 'Run one cycle now'}
            </button>
          </div>
        }
      >
        {result && <p className="mb-2 text-xs text-mint">{result}</p>}
        {runError && <p className="mb-2 text-xs text-amber-soft">Run failed: {runError}</p>}
        {jobs.data === undefined ? (
          jobs.error ? <ErrorState message={jobs.error} onRetry={jobs.reload} /> : <Loading label="Loading jobs…" />
        ) : (
          <DataTable
            rows={jobs.data.jobs}
            columns={jobColumns}
            rowKey={(j) => j.name}
            label="crypto jobs"
            empty={<p className="py-4 text-sm text-mist">No jobs have run yet — start the server with CRYPTO_WORKERS=1.</p>}
            defaultSort={{ key: 'last', dir: 'desc' }}
          />
        )}
      </Card>

      <Card
        title="Top-K ranking (shadow)"
        subtitle="records what an 'enter only the best K by score' rule would have kept — it never gates a trade"
      >
        {shadow.data === undefined ? (
          shadow.error ? <ErrorState message={shadow.error} onRetry={shadow.reload} /> : <Loading label="Loading shadow ranking…" />
        ) : (
          (() => {
            const sh = {
              enabled: shadow.data.enabled ?? false,
              k: shadow.data.k ?? 0,
              decisionImpact: shadow.data.decisionImpact ?? 'NONE — records only',
              recorded: shadow.data.recorded ?? 0,
              selected: shadow.data.selected ?? 0,
              takenByProduction: shadow.data.takenByProduction ?? 0,
              outcomes: shadow.data.outcomes ?? [],
            };
            const band = (sel: number): { n: number; wins: number; pnl: number } => {
              const row = sh.outcomes.find((o) => Number(o.selected) === sel);
              return { n: row?.n ?? 0, wins: row?.wins ?? 0, pnl: row?.netPnl ?? 0 };
            };
            const kept = band(1);
            const dropped = band(0);
            const winLine = (b: { n: number; wins: number }): string =>
              b.n > 0 ? `${b.wins}/${b.n} wins (${Math.round((b.wins / b.n) * 100)}%)` : 'no closed trades yet';
            return (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatTile label="Recorder" value={sh.enabled ? 'on' : 'off'} hint={sh.k ? `best ${sh.k} per scan` : '—'} tone={sh.enabled ? 'pos' : 'neutral'} />
                  <StatTile label="Candidates" value={String(sh.recorded)} hint="BUY signals ranked" />
                  <StatTile label="Would keep" value={String(sh.selected)} hint="top-K by score" />
                  <StatTile label="Traded anyway" value={String(sh.takenByProduction)} hint="production took all" />
                </div>
                <p className="mt-3 text-xs text-mist">{sh.decisionImpact}</p>
                <p className="mt-1 text-xs text-slate-soft">
                  top-K outcomes: <span className="font-mono">{winLine(kept)}</span>
                  {' · '}outside top-K: <span className="font-mono">{winLine(dropped)}</span>
                  {kept.n + dropped.n === 0
                    ? ' — evidence accrues as these trades close; promotion to a live gate needs your approval and forward evidence.'
                    : ''}
                </p>
              </>
            );
          })()
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Recent errors" subtitle="last five job failures, newest last">
          {s.recentErrors.length === 0 ? (
            <p className="text-sm text-mist">No errors recorded this run.</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {s.recentErrors.map((e, i) => (
                <li key={`${e.job}-${e.at}-${i}`} className="border-b border-line/60 pb-2 last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-slate-soft">{e.job}</span>
                    <span className="text-mist">{dateText(e.at)}</span>
                  </div>
                  <p className="mt-0.5 text-amber-soft">{e.message}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Membership log" subtitle="universe changes, most recent first">
          {s.universe.changes.length === 0 ? (
            <p className="text-sm text-mist">No membership changes yet — ranks refresh every 6 hours.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {s.universe.changes.slice(0, 10).map((c, i) => (
                <li key={`${c.symbol}-${c.ts}-${i}`} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-slate-soft">{c.symbol}</span>
                  <Badge tone={c.action === 'DROP' ? 'neg' : 'pos'}>{c.action.toLowerCase()}</Badge>
                  <span className="text-mist">{time(c.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
