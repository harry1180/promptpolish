/**
 * System — market session, scheduler jobs, workers, database health, data
 * quality, broker + kill switch, LLM status and data-source health.
 */

import { getStatus, getSystem } from '../api';
import type { StatusResponse, SystemResponse } from '../api';
import { useEndpoint } from '../data';
import {
  Badge,
  Card,
  DataTable,
  ErrorState,
  Loading,
  SessionBadge,
  StatTile,
  StatusPill,
  dateText,
  flex,
  number,
  time,
} from '../ui';

function statusTone(s: string | null | undefined): 'pos' | 'neg' | 'warn' | 'neutral' {
  const v = (s ?? '').toLowerCase();
  if (v === 'ok' || v === 'healthy' || v === 'connected') return 'pos';
  if (v === 'error' || v === 'failed' || v === 'down') return 'neg';
  if (v === 'never' || v === 'degraded') return 'warn';
  return 'neutral';
}

export function SystemPage() {
  const ep = useEndpoint<SystemResponse>('/system', getSystem);
  const status = useEndpoint<StatusResponse>('/status', getStatus);

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading system status…" />;
  }
  const d = ep.data;
  const kill = d.killSwitch ?? {};

  return (
    <div className="space-y-4">
      {/* headline tiles */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Mode" value={<span className="text-base">{d.mode ?? '—'}</span>} tone="warn" hint={d.pilotMode ? 'pilot mode' : undefined} />
        <StatTile label="Database" value={<span className="text-base">{d.db?.healthy ? 'healthy' : 'unhealthy'}</span>} tone={d.db?.healthy ? 'pos' : 'neg'} hint={`${number(d.db?.sizeBytes ?? null)} bytes · ${number(d.db?.tables ?? null)} tables`} />
        <StatTile label="Workers" value={<span className="text-base">{d.workers?.enabled ? 'running' : 'stopped'}</span>} tone={d.workers?.enabled ? 'pos' : 'neg'} hint={`since ${time(d.workers?.startedAt ?? null)} · ${number(d.workers?.ticks ?? null)} ticks`} />
        <StatTile label="Broker" value={<span className="text-base">{d.broker?.status ?? '—'}</span>} tone={statusTone(d.broker?.status)} hint={`${d.broker?.mode ?? '—'} · ${number(d.broker?.pendingOrders ?? null)} pending · ${number(d.broker?.openPositions ?? null)} open`} />
        <StatTile label="Stale quotes" value={number(d.dataQuality?.staleQuotes ?? null)} tone={(d.dataQuality?.staleQuotes ?? 0) > 0 ? 'warn' : 'pos'} hint={d.dataQuality?.lastQuoteAgeMs === null || d.dataQuality?.lastQuoteAgeMs === undefined ? '—' : `last quote ${number(d.dataQuality.lastQuoteAgeMs)} ms ago`} />
      </div>

      {/* kill switch */}
      <Card
        title="Kill switch"
        actions={
          <Badge tone={kill.active ? 'neg' : 'pos'}>{kill.active ? 'ACTIVE — trading halted' : 'armed (inactive)'}</Badge>
        }
        className={kill.active ? 'border-danger/50' : ''}
      >
        {kill.active ? (
          <ul className="space-y-1">
            {(kill.reasons ?? []).map((r, i) => (
              <li key={i} className="text-xs text-danger">
                {r}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-mist">
            No halt conditions are in force. When active, the kill switch blocks every new paper order until the
            listed reasons clear.
          </p>
        )}
      </Card>

      {/* execution guard straight from GET /status */}
      <Card title="Execution guard" subtitle={status.data ? status.data.executionGuard.mode : 'reading guard…'}>
        {status.data ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-line bg-ink-900/70 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-mist">realMoneyBlocked</div>
              <div className="mt-0.5 font-mono text-sm text-mint">{String(status.data.executionGuard.realMoneyBlocked)}</div>
            </div>
            <div className="rounded-md border border-line bg-ink-900/70 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-mist">adapters</div>
              <div className="mt-0.5 font-mono text-sm text-slate-soft">{status.data.executionGuard.adapters.join(', ')}</div>
            </div>
            <div className="rounded-md border border-amber-soft/40 bg-amber-soft/10 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-amber-soft">prohibited</div>
              <div className="mt-0.5 font-mono text-[11px] text-amber-soft">{status.data.executionGuard.prohibited.join(' · ')}</div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-mist">{status.error ? `guard unavailable: ${status.error}` : 'Reading guard…'}</p>
        )}
      </Card>

      {/* session */}
      <Card title="Market session" subtitle={dateText(d.market?.date ?? null)}>
        <div className="flex flex-wrap items-center gap-2">
          <SessionBadge session={d.market?.session} date={d.market?.date ?? null} />
          {d.market?.nextSession && (
            <span className="font-mono text-[11px] text-mist">next {dateText(d.market.nextSession.date)}</span>
          )}
        </div>
      </Card>

      {/* jobs */}
      <Card title="Jobs" subtitle="Scheduler state — last run, duration and the last error verbatim.">
        <DataTable
          label="Jobs"
          rows={d.jobs ?? []}
          rowKey={(r) => r.name}
          columns={[
            { key: 'name', header: 'Job', sortValue: (r) => r.name, cell: (r) => <span className="font-mono text-xs text-slate-soft">{r.name}</span> },
            { key: 'schedule', header: 'Schedule', cell: (r) => <span className="font-mono text-[11px] text-mist">{r.schedule ?? '—'}</span> },
            { key: 'lastRun', header: 'Last run', cell: (r) => <span className="font-mono text-xs">{time(r.lastRun ?? null)}</span> },
            {
              key: 'status',
              header: 'Status',
              cell: (r) => <Badge tone={statusTone(r.lastStatus)}>{r.lastStatus ?? '—'}</Badge>,
            },
            { key: 'duration', header: 'Duration', align: 'right', cell: (r) => <span className="font-mono text-xs">{r.durationMs === null || r.durationMs === undefined ? '—' : `${number(r.durationMs)} ms`}</span> },
            { key: 'error', header: 'Error', cell: (r) => <span className="text-[11px] text-danger">{r.lastError ?? ''}</span> },
          ]}
          empty={<p className="py-3 text-center text-xs text-mist">No jobs registered.</p>}
        />
      </Card>

      {/* data quality + llm */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Data quality">
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Stale quotes" value={number(d.dataQuality?.staleQuotes ?? null)} />
            <StatTile label="Missing bars" value={number(d.dataQuality?.missingBars ?? null)} />
            <StatTile label="Provider disagreements" value={number(d.dataQuality?.providerDisagreements ?? null)} />
            <StatTile label="Last quote age" value={d.dataQuality?.lastQuoteAgeMs === null || d.dataQuality?.lastQuoteAgeMs === undefined ? '—' : `${number(d.dataQuality.lastQuoteAgeMs)} ms`} />
          </div>
        </Card>

        <Card title="LLM status" actions={<Badge tone={d.llm?.mode === 'NORMAL' ? 'pos' : 'info'}>{d.llm?.mode ?? '—'}</Badge>}>
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-2 text-xs text-mist">
              Groq <StatusPill status={String(d.llm?.groq ?? 'UNAVAILABLE')} />
            </span>
            <span className="flex items-center gap-2 text-xs text-mist">
              Gemini <StatusPill status={String(d.llm?.gemini ?? 'UNAVAILABLE')} />
            </span>
          </div>
        </Card>
      </div>

      {/* data sources */}
      <Card title="Data sources">
        <DataTable
          label="Data sources"
          rows={d.dataSources ?? []}
          rowKey={(r) => r.name}
          columns={[
            { key: 'name', header: 'Source', sortValue: (r) => r.name, cell: (r) => <span className="font-mono text-xs text-slate-soft">{r.name}</span> },
            { key: 'status', header: 'Status', cell: (r) => <Badge tone={statusTone(r.status)}>{r.status ?? '—'}</Badge> },
            { key: 'success', header: 'Last success', cell: (r) => <span className="font-mono text-xs">{time(r.lastSuccess ?? null)}</span> },
            { key: 'error', header: 'Last error', cell: (r) => <span className="text-[11px] text-danger">{r.lastError ?? ''}</span> },
          ]}
          empty={<p className="py-3 text-center text-xs text-mist">No data sources reported.</p>}
        />
      </Card>

      <p className="text-[11px] text-mist">Workers config: {flex(d.workers ?? null)}</p>
    </div>
  );
}