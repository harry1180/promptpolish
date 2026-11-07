/**
 * Backtests — run history with per-fold breakdown (TRAIN / VALIDATION /
 * OUT_OF_SAMPLE), excess-vs-benchmark colouring, violations count (must be
 * 0), plus the POST /backtests form. While a run is RUNNING the page
 * refetches every 5s; otherwise the normal 60s poll applies.
 */

import { useState } from 'react';
import { getBacktests, postBacktest } from '../api';
import type { BacktestRun, BacktestsResponse } from '../api';
import { REFRESH_MS, useEndpoint } from '../data';
import {
  Badge,
  BarChart,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Loading,
  StatTile,
  dateText,
  number,
  pct,
  pctAuto,
  pctPlain,
  time,
  toneClass,
} from '../ui';

const FAST_POLL_MS = 5_000;

function foldTone(name: string): 'pos' | 'neg' | 'info' | 'warn' | 'neutral' {
  const n = name.toUpperCase();
  if (n.includes('OUT_OF_SAMPLE')) return 'pos';
  if (n.includes('VALIDATION')) return 'info';
  if (n.includes('TRAIN')) return 'neutral';
  return 'neutral';
}

function RunDetail({ run }: { run: BacktestRun }) {
  const folds = run.folds ?? [];
  return (
    <div className="border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold text-slate-soft">
          {run.strategy} · {dateText(run.startDate)} → {dateText(run.endDate)}
        </span>
        <Badge tone={run.status === 'DONE' ? 'pos' : run.status === 'ERROR' ? 'neg' : 'warn'}>{run.status}</Badge>
        <Badge tone={(run.violations ?? 0) === 0 ? 'pos' : 'neg'}>{number(run.violations ?? null)} violations</Badge>
        <span className="font-mono text-[11px] text-mist">created {time(run.createdAt ?? null)}</span>
      </div>

      {folds.length === 0 ? (
        <p className="mt-2 text-xs text-mist">No fold breakdown published for this run.</p>
      ) : (
        <>
          <div className="mt-2">
            <BarChart
              ariaLabel={`fold returns for ${run.strategy}`}
              data={folds.map((f) => ({ label: f.name, value: f.returnPct ?? null }))}
            />
          </div>
          <DataTable
            label={`Folds for ${run.strategy}`}
            rows={folds}
            rowKey={(f) => `${run.id}-${f.name}`}
            columns={[
              {
                key: 'name',
                header: 'Fold',
                cell: (f) => <Badge tone={foldTone(f.name)}>{f.name}</Badge>,
              },
              { key: 'start', header: 'Start', cell: (f) => <span className="font-mono text-xs">{dateText(f.start ?? '')}</span> },
              { key: 'end', header: 'End', cell: (f) => <span className="font-mono text-xs">{dateText(f.end ?? '')}</span> },
              { key: 'ret', header: 'Return', align: 'right', cell: (f) => <span className={`font-mono ${toneClass(f.returnPct ?? null)}`}>{pctAuto(f.returnPct ?? null)}</span> },
              { key: 'bench', header: 'Benchmark', align: 'right', cell: (f) => <span className="font-mono text-mist">{pctAuto(f.benchmarkReturnPct ?? null)}</span> },
              { key: 'excess', header: 'Excess', align: 'right', cell: (f) => {
                const excess = f.returnPct !== null && f.returnPct !== undefined && f.benchmarkReturnPct !== null && f.benchmarkReturnPct !== undefined
                  ? f.returnPct - f.benchmarkReturnPct
                  : null;
                return <span className={`font-mono ${toneClass(excess)}`}>{pctAuto(excess)}</span>;
              } },
              { key: 'trades', header: 'Trades', align: 'right', cell: (f) => <span className="font-mono">{number(f.trades ?? null)}</span> },
            ]}
          />
        </>
      )}
    </div>
  );
}

export function BacktestsPage() {
  const ep = useEndpoint<BacktestsResponse>('/backtests', getBacktests, REFRESH_MS);
  const runs = ep.data?.runs ?? [];
  const anyRunning = runs.some((r) => r.status === 'RUNNING');
  // fast poll while a run is active (stable: `anyRunning` only changes when data changes)
  const poll = useEndpoint<BacktestsResponse>(anyRunning ? '/backtests?poll=fast' : '/backtests', getBacktests, anyRunning ? FAST_POLL_MS : REFRESH_MS);

  const [strategy, setStrategy] = useState('SHORT_TERM');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data = poll.data ?? ep.data;
  const allRuns = data?.runs ?? [];
  const stillRunning = allRuns.some((r) => r.status === 'RUNNING');

  async function submit(): Promise<void> {
    if (!startDate || !endDate || posting) return;
    setPosting(true);
    setMessage(null);
    setError(null);
    try {
      const res = await postBacktest({ strategy, startDate, endDate });
      setMessage(`Backtest queued — run ${res.runId}`);
      poll.reload();
      ep.reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }

  if (data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading backtests…" />;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Runs" value={number(allRuns.length)} />
        <StatTile label="Running" value={number(allRuns.filter((r) => r.status === 'RUNNING').length)} tone={stillRunning ? 'warn' : 'neutral'} />
        <StatTile
          label="Zero-violation runs"
          value={`${number(allRuns.filter((r) => (r.violations ?? 0) === 0).length)} / ${number(allRuns.length)}`}
          tone="pos"
          hint="lookahead / overfit gates"
        />
        <StatTile label="Errors" value={number(allRuns.filter((r) => r.status === 'ERROR').length)} tone="neg" />
      </div>

      {/* run request form */}
      <Card title="Run a backtest" subtitle="POST /backtests — rate-limited; one active run per IP.">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
            Strategy
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              className="rounded-md border border-line bg-ink-800 px-2 py-1 text-xs text-slate-soft"
            >
              <option value="SHORT_TERM">SHORT_TERM</option>
              <option value="LONG_TERM">LONG_TERM</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
            Start date
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded-md border border-line bg-ink-800 px-2 py-1 font-mono text-xs text-slate-soft"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-mist">
            End date
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="rounded-md border border-line bg-ink-800 px-2 py-1 font-mono text-xs text-slate-soft"
            />
          </label>
          <button
            type="button"
            disabled={posting || !startDate || !endDate}
            onClick={() => void submit()}
            className="rounded-md border border-mint/50 bg-mint/10 px-4 py-1.5 text-sm text-mint disabled:cursor-not-allowed disabled:opacity-50"
          >
            {posting ? 'Queueing…' : stillRunning ? 'Run backtest (a run is active)' : 'Run backtest'}
          </button>
          {message && <span className="font-mono text-xs text-mint">{message}</span>}
          {error && <span role="alert" className="font-mono text-xs text-danger">{error}</span>}
        </div>
        <p className="mt-2 text-[11px] text-mist">
          {stillRunning ? 'A run is active — results refresh every 5s until it finishes.' : 'Idle — results refresh every 60s.'}
        </p>
      </Card>

      {/* run-level summary */}
      <Card title="Runs" subtitle="Run-level results — excess vs benchmark, violations must be 0.">
        <DataTable
          label="Backtest runs"
          rows={allRuns}
          rowKey={(run) => run.id}
          columns={[
            { key: 'strategy', header: 'Strategy', sortValue: (run) => run.strategy, cell: (run) => <span className="font-mono text-xs text-slate-soft">{run.strategy}</span> },
            { key: 'period', header: 'Period', cell: (run) => <span className="font-mono text-xs text-mist">{dateText(run.startDate)} → {dateText(run.endDate)}</span> },
            { key: 'status', header: 'Status', cell: (run) => <Badge tone={run.status === 'DONE' ? 'pos' : run.status === 'ERROR' ? 'neg' : 'warn'}>{run.status}</Badge> },
            { key: 'total', header: 'Total return', align: 'right', sortValue: (run) => run.totalReturnPct ?? null, cell: (run) => <span className={`font-mono ${toneClass(run.totalReturnPct ?? null)}`}>{pct(run.totalReturnPct ?? null)}</span> },
            { key: 'bench', header: 'Benchmark', align: 'right', sortValue: (run) => run.benchmarkReturnPct ?? null, cell: (run) => <span className="font-mono text-mist">{pct(run.benchmarkReturnPct ?? null)}</span> },
            { key: 'excess', header: 'Excess', align: 'right', sortValue: (run) => run.excessReturnPct ?? null, cell: (run) => <span className={`font-mono ${toneClass(run.excessReturnPct ?? null)}`}>{pct(run.excessReturnPct ?? null)}</span> },
            { key: 'maxdd', header: 'Max drawdown', align: 'right', cell: (run) => <span className="font-mono text-danger">{pct(run.maxDrawdownPct ?? null)}</span> },
            { key: 'winrate', header: 'Win rate', align: 'right', cell: (run) => <span className="font-mono text-slate-soft">{pctPlain(run.winRatePct ?? null)}</span> },
            { key: 'trades', header: 'Trades', align: 'right', cell: (run) => <span className="font-mono">{number(run.trades ?? null)}</span> },
            { key: 'violations', header: 'Violations', align: 'right', cell: (run) => <Badge tone={(run.violations ?? 0) === 0 ? 'pos' : 'neg'}>{number(run.violations ?? null)}</Badge> },
            { key: 'created', header: 'Created', cell: (run) => <span className="font-mono text-[11px] text-mist">{time(run.createdAt ?? null)}</span> },
          ]}
          empty={<p className="py-3 text-center text-xs text-mist">No backtests yet — queue a run above.</p>}
        />
      </Card>

      {/* fold detail */}
      <Card title="Fold breakdown" subtitle="TRAIN / VALIDATION / OUT_OF_SAMPLE per run.">
        {allRuns.length === 0 ? (
          <EmptyState title="No backtests yet">Queue a run above — history will appear here.</EmptyState>
        ) : (
          <div className="space-y-4">
            {allRuns.map((run) => (
              <RunDetail key={run.id} run={run} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}