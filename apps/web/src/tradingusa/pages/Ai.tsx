/**
 * AI — provider cards, usage totals, budget meters, ablation results,
 * value-router decisions and mode.
 *
 * SECURITY: only explicitly known fields are ever read from the response —
 * nothing is spread into the DOM, so a key-like field in a payload can never
 * be rendered. If a suspicious key shows up it is dropped, not displayed.
 */

import { getAi } from '../api';
import type { AiProvider, AiResponse } from '../api';
import { useEndpoint } from '../data';
import {
  Badge,
  Card,
  DataTable,
  ErrorState,
  HBar,
  Loading,
  MeterBar,
  StatTile,
  StatusPill,
  number,
  pct,
  pctPlain,
  time,
  toneClass,
} from '../ui';

/**
 * Drop anything that is not an explicitly known, non-sensitive field: the
 * allow-list below is the only path from a response object to the DOM.
 */
function pickProvider(p: AiProvider): {
  name: string;
  status: string;
  model: string;
  role: string;
  callsToday: number | null;
  callsWeek: number | null;
  inputTokensToday: number | null;
  outputTokensToday: number | null;
  inputTokensWeek: number | null;
  outputTokensWeek: number | null;
  cacheHitRatePct: number | null;
  rateLimitResetMs: number | null;
  lastError: string | null;
} {
  return {
    name: p.name,
    status: p.status,
    model: p.model ?? '—',
    role: p.role ?? '—',
    callsToday: p.callsToday ?? null,
    callsWeek: p.callsWeek ?? null,
    inputTokensToday: p.inputTokensToday ?? null,
    outputTokensToday: p.outputTokensToday ?? null,
    inputTokensWeek: p.inputTokensWeek ?? null,
    outputTokensWeek: p.outputTokensWeek ?? null,
    cacheHitRatePct: p.cacheHitRatePct ?? null,
    rateLimitResetMs: p.rateLimitResetMs ?? null,
    lastError: p.lastError ?? null,
  };
}

function ProviderCard({ p }: { p: ReturnType<typeof pickProvider> }) {
  const rows: Array<[string, string]> = [
    ['model', p.model],
    ['role', p.role],
    ['calls today / week', `${number(p.callsToday)} / ${number(p.callsWeek)}`],
    ['input tokens today / week', `${number(p.inputTokensToday)} / ${number(p.inputTokensWeek)}`],
    ['output tokens today / week', `${number(p.outputTokensToday)} / ${number(p.outputTokensWeek)}`],
    ['cache hit rate', pctPlain(p.cacheHitRatePct)],
    ['rate-limit reset', p.rateLimitResetMs === null ? '—' : `${number(p.rateLimitResetMs)} ms`],
    ['last error', p.lastError ?? 'none'],
  ];
  return (
    <Card
      title={p.name}
      actions={
        <span className="flex gap-1.5">
          <StatusPill status={p.status} />
          <Badge tone={p.role === 'primary' ? 'pos' : 'info'}>{p.role}</Badge>
        </span>
      }
    >
      <dl className="space-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-line/50 pb-1 last:border-b-0">
            <dt className="text-mist">{k}</dt>
            <dd className="truncate font-mono text-slate-soft">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export function AiPage() {
  const ep = useEndpoint<AiResponse>('/ai', getAi);

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading AI usage…" />;
  }
  const d = ep.data;
  const providers = (d.providers ?? []).map(pickProvider);
  const totals = d.totals ?? {};
  const budgets = d.budgets ?? {};
  const ablation = d.ablation ?? {};
  const router = d.valueRouter ?? {};

  const routinePct =
    budgets.routineCallsPerDay && budgets.routineRemaining !== null && budgets.routineRemaining !== undefined
      ? (budgets.routineRemaining / budgets.routineCallsPerDay) * 100
      : null;
  const highPct =
    budgets.highPriorityCallsPerDay && budgets.highPriorityRemaining !== null && budgets.highPriorityRemaining !== undefined
      ? (budgets.highPriorityRemaining / budgets.highPriorityCallsPerDay) * 100
      : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={d.mode === 'NORMAL' ? 'pos' : 'info'}>{d.mode ?? '—'}</Badge>
        <span className="text-xs text-mist">LLM dependency {pctPlain(totals.llmDependencyPct ?? null)} of decisions</span>
        <span className="ml-auto font-mono text-[11px] text-mist">refreshed {time(Date.now())}</span>
      </div>

      {/* providers */}
      <div className="grid gap-4 lg:grid-cols-2">
        {providers.map((p) => (
          <ProviderCard key={p.name} p={p} />
        ))}
      </div>

      {/* totals */}
      <Card title="Totals">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
          <StatTile label="Calls today" value={number(totals.callsToday ?? null)} />
          <StatTile label="Tokens today" value={number(totals.tokensToday ?? null)} />
          <StatTile label="Est. cost" value={totals.estCostUsd === null || totals.estCostUsd === undefined ? '—' : `$${number(totals.estCostUsd)}`} />
          <StatTile label="Cache hit" value={pctPlain(totals.cacheHitRatePct ?? null)} tone="pos" />
          <StatTile label="Avoided by cache" value={number(totals.avoidedByCache ?? null)} />
          <StatTile label="Avoided by local" value={number(totals.avoidedByLocalProcessing ?? null)} />
          <StatTile label="LLM dependency" value={pctPlain(totals.llmDependencyPct ?? null)} />
        </div>
      </Card>

      {/* budgets */}
      <Card title="Budgets" subtitle={`reserve ${number(budgets.reservePercent ?? null)}% untouched for high-priority calls`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="uppercase tracking-wide text-mist">Routine calls remaining</span>
              <span className="font-mono text-slate-soft">
                {number(budgets.routineRemaining ?? null)} / {number(budgets.routineCallsPerDay ?? null)}
              </span>
            </div>
            <MeterBar value={routinePct} tone={routinePct !== null && routinePct < 20 ? 'neg' : 'pos'} width="w-full" />
          </div>
          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="uppercase tracking-wide text-mist">High-priority calls remaining</span>
              <span className="font-mono text-slate-soft">
                {number(budgets.highPriorityRemaining ?? null)} / {number(budgets.highPriorityCallsPerDay ?? null)}
              </span>
            </div>
            <MeterBar value={highPct} tone={highPct !== null && highPct < 20 ? 'warn' : 'info'} width="w-full" />
          </div>
          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="uppercase tracking-wide text-mist">Groq tokens / day</span>
              <span className="font-mono text-slate-soft">{number(budgets.groqTokensPerDay ?? null)}</span>
            </div>
          </div>
          <div>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="uppercase tracking-wide text-mist">Gemini tokens / day</span>
              <span className="font-mono text-slate-soft">{number(budgets.geminiTokensPerDay ?? null)}</span>
            </div>
          </div>
        </div>
      </Card>

      {/* ablation */}
      <Card
        title="Ablation — does the LLM actually help?"
        subtitle={`${number(ablation.evaluated ?? null)} evaluations`}
        actions={
          <span className="flex gap-1.5">
            <Badge tone="pos">{number(ablation.improved ?? null)} improved</Badge>
            <Badge tone="neutral">{number(ablation.noEffect ?? null)} no effect</Badge>
            <Badge tone="neg">{number(ablation.worse ?? null)} worse</Badge>
            <Badge tone={toneClass(ablation.incrementalAlphaPct ?? null) === 'text-danger' ? 'neg' : 'info'}>
              incremental alpha {pct(ablation.incrementalAlphaPct ?? null)}
            </Badge>
          </span>
        }
      >
        <DataTable
          label="Ablation by task"
          rows={ablation.byTask ?? []}
          rowKey={(r) => r.task}
          columns={[
            { key: 'task', header: 'Task', sortValue: (r) => r.task, cell: (r) => <span className="text-xs text-slate-soft">{r.task}</span> },
            { key: 'base', header: 'Base accuracy', align: 'right', sortValue: (r) => r.baseAccuracy ?? null, cell: (r) => <span className="font-mono text-mist">{pctPlain(r.baseAccuracy ?? null)}</span> },
            { key: 'aug', header: 'Augmented accuracy', align: 'right', sortValue: (r) => r.augmentedAccuracy ?? null, cell: (r) => <span className="font-mono text-slate-soft">{pctPlain(r.augmentedAccuracy ?? null)}</span> },
            { key: 'inc', header: 'Incremental', align: 'right', sortValue: (r) => r.incrementalAccuracy ?? null, cell: (r) => <span className={`font-mono ${toneClass(r.incrementalAccuracy ?? null)}`}>{pct(r.incrementalAccuracy ?? null)}</span> },
            { key: 'calls', header: 'Calls', align: 'right', cell: (r) => <span className="font-mono">{number(r.calls ?? null)}</span> },
            { key: 'tokens', header: 'Tokens', align: 'right', cell: (r) => <span className="font-mono">{number(r.tokens ?? null)}</span> },
          ]}
          empty={<p className="py-3 text-center text-xs text-mist">No ablation evaluations yet.</p>}
        />
        {(ablation.byTask ?? []).length > 0 && (
          <div className="mt-3 space-y-0.5">
            {(ablation.byTask ?? []).map((t) => (
              <HBar
                key={t.task}
                label={t.task}
                value={(t.incrementalAccuracy ?? 0) * 100}
                display={pct(t.incrementalAccuracy ?? null)}
                tone={(t.incrementalAccuracy ?? 0) > 0 ? 'pos' : (t.incrementalAccuracy ?? 0) < 0 ? 'neg' : 'neutral'}
                max={10}
              />
            ))}
          </div>
        )}
      </Card>

      {/* value router */}
      <Card title="Value router" subtitle={`threshold ${number(router.threshold ?? null)} — tasks below it are handled locally`}>
        <DataTable
          label="Value router decisions"
          rows={router.recent ?? []}
          rowKey={(r) => r.task}
          columns={[
            { key: 'task', header: 'Task', cell: (r) => <span className="text-xs text-slate-soft">{r.task}</span> },
            { key: 'value', header: 'Value score', align: 'right', cell: (r) => <span className="font-mono text-slate-soft">{number(r.value ?? null)}</span> },
            {
              key: 'invoked',
              header: 'LLM invoked',
              cell: (r) => <Badge tone={r.invoked ? 'pos' : 'neutral'}>{r.invoked ? 'YES' : 'NO'}</Badge>,
            },
            { key: 'reason', header: 'Reason', cell: (r) => <span className="text-xs text-mist">{r.reason ?? '—'}</span> },
          ]}
          empty={<p className="py-3 text-center text-xs text-mist">No router decisions yet.</p>}
        />
      </Card>

      {/* recent calls */}
      <Card title="Recent calls">
        <DataTable
          label="Recent LLM calls"
          rows={d.recent ?? []}
          rowKey={(r) => `${String(r.ts ?? '')}-${String(r.provider ?? '')}-${String(r.task ?? '')}`}
          columns={[
            { key: 'ts', header: 'Time', cell: (r) => <span className="font-mono text-xs">{time(r.ts ?? null)}</span> },
            { key: 'provider', header: 'Provider', cell: (r) => <Badge tone="neutral">{r.provider ?? '—'}</Badge> },
            { key: 'task', header: 'Task', cell: (r) => <span className="text-xs text-slate-soft">{r.task ?? '—'}</span> },
            { key: 'status', header: 'Status', cell: (r) => <StatusPill status={r.status ?? null} /> },
            { key: 'latency', header: 'Latency', align: 'right', cell: (r) => <span className="font-mono text-xs">{r.latencyMs === null || r.latencyMs === undefined ? '—' : `${number(r.latencyMs)} ms`}</span> },
            { key: 'tokens', header: 'Tokens', align: 'right', cell: (r) => <span className="font-mono text-xs">{number(r.tokens ?? null)}</span> },
            { key: 'cached', header: 'Cached', cell: (r) => <Badge tone={r.cached ? 'pos' : 'neutral'}>{r.cached ? 'HIT' : 'MISS'}</Badge> },
          ]}
          empty={<p className="py-3 text-center text-xs text-mist">No LLM calls recorded yet.</p>}
        />
      </Card>

      <p className="text-[11px] text-mist">
        Rendering policy: only the known fields above are read from GET /ai. Credential-like fields in a payload are
        dropped before render and never reach the DOM.
      </p>
    </div>
  );
}