/**
 * AI Performance (agent vs governance, side by side), Blast Radius
 * (per-agent dimensions, breaches, remaining daily budget) and Incidents
 * (status workflow).
 *
 * Agent performance and governance performance are deliberately separate
 * dashboards: a high-performing model can still be poorly governed.
 */

import type { BlastBreach, BlastRadius, IncidentRow } from '@promptslim/act';
import { useEndpoint } from '../data';
import { Badge, Bar, Card, earlyState, fmtUsd, levelTone, riskTone, Table } from '../ui';
import type { Column, Tone } from '../ui';

/* ------------------------------------------------------------------ */
/* performance                                                         */
/* ------------------------------------------------------------------ */

interface PerformancePayload {
  agent: Record<string, number>;
  governance: Record<string, number>;
  note: string;
}

function metricLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function metricDisplay(key: string, value: number): string {
  if (/Sec$/i.test(key)) return `${value} s`;
  if (/Ms$/i.test(key)) return `${value} ms`;
  return String(value);
}

const AGENT_POSITIVE = new Set(['taskSuccess', 'evidenceCoverage']);
const GOV_POSITIVE = new Set(['governanceScore', 'evidenceCoverage', 'approvalsBound']);

function metricTone(key: string, positive: Set<string>): Tone {
  return positive.has(key) ? 'ok' : 'info';
}

export function PerformancePage() {
  const ep = useEndpoint<PerformancePayload>('/performance');
  const early = earlyState(ep, 'Loading performance…');
  if (early) return early;
  const { agent, governance, note } = ep.data!;

  const agentMax = Math.max(...Object.values(agent), 1);
  const govMax = Math.max(...Object.values(governance), 1);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Agent performance" subtitle="Outcome quality of the models and workflows themselves.">
          <div className="space-y-0.5">
            {Object.entries(agent).map(([k, v]) => (
              <Bar
                key={k}
                label={metricLabel(k)}
                value={v}
                max={agentMax}
                display={metricDisplay(k, v)}
                tone={metricTone(k, AGENT_POSITIVE)}
              />
            ))}
          </div>
        </Card>

        <Card title="Governance performance" subtitle="Control effectiveness — measured independently of model quality.">
          <div className="space-y-0.5">
            {Object.entries(governance).map(([k, v]) => (
              <Bar
                key={k}
                label={metricLabel(k)}
                value={v}
                max={govMax}
                display={metricDisplay(k, v)}
                tone={metricTone(k, GOV_POSITIVE)}
              />
            ))}
          </div>
        </Card>
      </div>

      <Card title="Reading note">
        <p className="text-sm text-mist">{note}</p>
        <p className="mt-2 text-xs text-mist">
          Bars are scaled inside each panel so the two dashboards are never read as one league table;
          error, override and block rates are not &ldquo;higher is better&rdquo; metrics.
        </p>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* blast radius                                                        */
/* ------------------------------------------------------------------ */

interface BlastRowShape {
  agentId: string;
  name: string;
  radius: BlastRadius;
  breaches: BlastBreach[] | { ok?: boolean; breaches: BlastBreach[]; remainingTodayUsd: number };
  remainingTodayUsd?: number;
}

type BlastPayload = BlastRowShape[] | { rows: BlastRowShape[] };

interface BlastView {
  agentId: string;
  name: string;
  radius: BlastRadius;
  breaches: BlastBreach[];
  remainingTodayUsd: number;
}

function normalizeBlast(payload: BlastPayload): BlastView[] {
  const rows = Array.isArray(payload) ? payload : payload.rows;
  return rows.map((r) => {
    if (Array.isArray(r.breaches)) {
      return {
        agentId: r.agentId,
        name: r.name,
        radius: r.radius,
        breaches: r.breaches,
        remainingTodayUsd: r.remainingTodayUsd ?? 0,
      };
    }
    return {
      agentId: r.agentId,
      name: r.name,
      radius: r.radius,
      breaches: r.breaches.breaches ?? [],
      remainingTodayUsd: r.breaches.remainingTodayUsd ?? r.remainingTodayUsd ?? 0,
    };
  });
}

export function BlastPage() {
  const ep = useEndpoint<BlastPayload>('/blast-radius');
  const early = earlyState(ep, 'Loading blast radius…');
  if (early) return early;
  const rows = normalizeBlast(ep.data!);

  const dimColumns: Array<Column<BlastRadius['dimensions'][number]>> = [
    { key: 'dimension', header: 'Dimension', cell: (d) => <span className="text-xs uppercase tracking-wider text-mist">{d.dimension}</span> },
    { key: 'level', header: 'Level', cell: (d) => <Badge tone={levelTone(d.level)}>{d.level}</Badge> },
    { key: 'value', header: 'Value', cell: (d) => <span className="font-mono text-xs text-slate-soft">{d.value}</span> },
    { key: 'why', header: 'Basis', cell: (d) => <span className="block max-w-xl text-xs text-mist">{d.explanation}</span> },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-mist">
        Blast radius is the maximum plausible impact before intervention — enforced at the gateway,
        never a reporting number. Remaining daily budget shows what is still spendable today.
      </p>
      {rows.map((r) => {
        const cap = r.radius.financialUsd;
        const used = Math.max(0, cap - r.remainingTodayUsd);
        return (
          <Card
            key={r.agentId}
            title={r.name}
            subtitle={r.radius.explanation}
            actions={
              <span className="flex gap-2">
                <Badge tone={levelTone(r.radius.overall)}>{r.radius.overall}</Badge>
                <Badge tone={r.breaches.length ? 'bad' : 'ok'}>
                  {r.breaches.length ? `${r.breaches.length} breach condition(s)` : 'no breach'}
                </Badge>
              </span>
            }
          >
            <div className="mb-3">
              <Table
                rows={r.radius.dimensions}
                columns={dimColumns}
                rowKey={(d) => d.dimension}
                label={`${r.name} blast dimensions`}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wider text-mist">Breach conditions</div>
                {r.breaches.length === 0 ? (
                  <p className="text-sm text-mist">No limit would be broken by the reference request.</p>
                ) : (
                  <ul className="space-y-1">
                    {r.breaches.map((b) => (
                      <li key={b.code} className="border-b border-line/50 pb-1 text-sm">
                        <span className="font-mono text-xs text-danger">{b.code}</span>{' '}
                        <span className="text-mist">{b.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wider text-mist">Remaining daily budget</div>
                <div className="font-mono text-xl text-slate-soft">
                  {fmtUsd(r.remainingTodayUsd)}
                  <span className="ml-2 text-xs text-mist">
                    of {cap ? fmtUsd(cap) : 'no financial capability'}
                  </span>
                </div>
                {cap > 0 && (
                  <div className="mt-2">
                    <Bar
                      label="executed today"
                      value={used}
                      max={cap}
                      display={`${fmtUsd(used)} / ${fmtUsd(cap)}`}
                      tone={used / cap > 0.8 ? 'bad' : 'info'}
                    />
                  </div>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* incidents                                                           */
/* ------------------------------------------------------------------ */

const STAGES: IncidentRow['status'][] = ['New', 'Triaged', 'Investigating', 'Contained', 'Remediating', 'Resolved', 'Closed'];

export function IncidentsPage() {
  const ep = useEndpoint<IncidentRow[]>('/incidents');
  const early = earlyState(ep, 'Loading incidents…');
  if (early) return early;
  const rows = [...ep.data!].sort((a, b) => b.openedAt - a.openedAt);

  const columns: Array<Column<IncidentRow>> = [
    { key: 'id', header: 'ID', cell: (i) => <span className="font-mono text-xs text-slate-soft">{i.id}</span> },
    { key: 'type', header: 'Type', cell: (i) => <span className="text-xs">{i.type}</span> },
    { key: 'severity', header: 'Severity', cell: (i) => <Badge tone={riskTone(i.severity)}>{i.severity}</Badge> },
    { key: 'title', header: 'Title', cell: (i) => <span className="text-xs text-mist">{i.title}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (i) => (
        <Badge tone={i.status === 'Closed' || i.status === 'Resolved' ? 'ok' : i.status === 'New' ? 'warn' : 'info'}>
          {i.status}
        </Badge>
      ),
    },
    { key: 'agent', header: 'Agent', cell: (i) => <span className="font-mono text-[11px] text-mist">{i.agentId ?? '—'}</span> },
    { key: 'opened', header: 'Opened', cell: (i) => <span className="font-mono text-xs">{new Date(i.openedAt).toISOString().slice(0, 16).replace('T', ' ')}Z</span> },
    { key: 'source', header: 'Source', cell: (i) => <Badge tone="info">{i.source}</Badge> },
  ];

  const byStage = STAGES.map((stage) => ({
    stage,
    count: rows.filter((r) => r.status === stage).length,
  }));

  return (
    <div className="space-y-4">
      <Card title="Status workflow" subtitle="Every incident moves through the same workflow; the strip shows where the estate currently sits.">
        <ol className="flex flex-wrap items-center gap-1.5">
          {byStage.map((s, i) => (
            <li key={s.stage} className="flex items-center gap-1.5">
              <span
                className={`rounded-md border px-2.5 py-1.5 font-mono text-xs ${
                  s.count > 0 ? 'border-mint/40 bg-mint/10 text-mint' : 'border-line bg-ink-900 text-mist/70'
                }`}
              >
                {s.stage}
                <span className="ml-2 text-[11px]">{s.count}</span>
              </span>
              {i < byStage.length - 1 && <span className="text-mist/60">→</span>}
            </li>
          ))}
        </ol>
      </Card>

      <Card title={`Incidents · ${rows.length}`} subtitle="Seeded baseline plus incidents opened by live demo activity.">
        <Table rows={rows} columns={columns} rowKey={(i) => i.id} label="Incidents" />
      </Card>
    </div>
  );
}