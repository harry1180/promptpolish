/**
 * Agent Registry (filterable) + Agent Passports (list and detail view).
 *
 * The passport detail contrasts APPROVED vs EFFECTIVE permissions so privilege
 * drift is visible, and shows prohibited capabilities, credential state,
 * review dates, kill capability and the blast radius.
 */

import { useState } from 'react';
import { useNavigate, useEndpoint } from '../data';
import type { DecisionRow, IncidentRow, RegistryRow, BlastRadius, BlastBreach } from '@promptslim/act';
import {
  Badge, Card, Chips, earlyState, Fields, fmtTime, fmtUsd, levelTone, riskTone, Table,
} from '../ui';
import type { Column } from '../ui';

/* ------------------------------------------------------------------ */
/* registry                                                            */
/* ------------------------------------------------------------------ */

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info'> = {
  active: 'ok',
  suspended: 'warn',
  quarantined: 'warn',
  killed: 'bad',
};

export function RegistryPage() {
  const ep = useEndpoint<RegistryRow[]>('/agents');
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [risk, setRisk] = useState('all');
  const [attentionOnly, setAttentionOnly] = useState(false);

  const early = earlyState(ep, 'Loading agent registry…');
  if (early) return early;
  const rows = ep.data!;

  const filtered = rows.filter((r) => {
    const q = query.trim().toLowerCase();
    if (q && !`${r.name} ${r.agentId} ${r.businessFunction} ${r.businessOwner}`.toLowerCase().includes(q)) return false;
    if (status !== 'all' && r.status !== status) return false;
    if (risk !== 'all' && r.riskTier !== risk) return false;
    if (attentionOnly && !r.needsAttention) return false;
    return true;
  });

  const columns: Array<Column<RegistryRow>> = [
    {
      key: 'name',
      header: 'Agent',
      cell: (r) => (
        <div>
          <a
            href={`/agent-control-tower/passports/${r.agentId}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/agent-control-tower/passports/${r.agentId}`);
            }}
            className="font-medium text-slate-soft hover:text-mint"
          >
            {r.name}
          </a>
          <div className="font-mono text-[11px] text-mist">{r.agentId}</div>
        </div>
      ),
    },
    { key: 'function', header: 'Function', cell: (r) => <span className="text-mist">{r.businessFunction}</span> },
    { key: 'env', header: 'Environment', cell: (r) => <span className="text-xs">{r.environment}</span> },
    { key: 'risk', header: 'Risk', cell: (r) => <Badge tone={riskTone(r.riskTier)}>{r.riskTier}</Badge> },
    { key: 'autonomy', header: 'Autonomy', cell: (r) => <span className="font-mono text-xs">{r.autonomyLevel}</span> },
    { key: 'status', header: 'Status', cell: (r) => <Badge tone={STATUS_TONE[r.status] ?? 'info'}>{r.status}</Badge> },
    { key: 'score', header: 'Score', cell: (r) => <span className="font-mono">{r.governanceScore}</span> },
    {
      key: 'blast',
      header: 'Blast radius',
      cell: (r) => <Badge tone={levelTone(r.blastRadiusClass)}>{r.blastRadiusClass}</Badge>,
    },
    {
      key: 'attention',
      header: 'Attention',
      cell: (r) =>
        r.needsAttention ? (
          <span className="text-xs text-amber-soft">{r.attentionReason ?? 'review required'}</span>
        ) : (
          <span className="text-xs text-mist">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <Card
        title={`Registry · ${filtered.length} of ${rows.length} agents`}
        subtitle="Registry rows are derived from passports plus live demo events — attention flags are findings, not labels."
        actions={
          <button
            type="button"
            onClick={ep.reload}
            className="rounded-md border border-line bg-ink-700 px-3 py-1 text-xs text-slate-soft hover:border-mint/40"
          >
            Refresh
          </button>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-mist">
            Search
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="name, id, function, owner"
              className="w-56 rounded-md border border-line bg-ink-900 px-2 py-1 font-mono text-xs text-slate-soft"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-mist">
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="rounded-md border border-line bg-ink-900 px-2 py-1 text-xs text-slate-soft"
            >
              <option value="all">all</option>
              <option value="active">active</option>
              <option value="suspended">suspended</option>
              <option value="killed">killed</option>
              <option value="quarantined">quarantined</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-mist">
            Risk tier
            <select
              value={risk}
              onChange={(e) => setRisk(e.target.value)}
              className="rounded-md border border-line bg-ink-900 px-2 py-1 text-xs text-slate-soft"
            >
              <option value="all">all</option>
              <option value="critical">critical</option>
              <option value="high">high</option>
              <option value="moderate">moderate</option>
              <option value="low">low</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-mist">
            <input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} />
            needs attention only
          </label>
        </div>

        <Table
          rows={filtered}
          columns={columns}
          rowKey={(r) => r.agentId}
          label="Agent registry"
          empty={<p className="text-sm text-mist">No agents match these filters.</p>}
        />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* passports list                                                      */
/* ------------------------------------------------------------------ */

export function PassportsPage() {
  const ep = useEndpoint<RegistryRow[]>('/agents');
  const navigate = useNavigate();
  const early = earlyState(ep, 'Loading agent passports…');
  if (early) return early;
  const rows = ep.data!;

  const columns: Array<Column<RegistryRow>> = [
    {
      key: 'name',
      header: 'Passport',
      cell: (r) => (
        <div>
          <a
            href={`/agent-control-tower/passports/${r.agentId}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/agent-control-tower/passports/${r.agentId}`);
            }}
            className="font-medium text-slate-soft hover:text-mint"
          >
            {r.name}
          </a>
          <div className="text-[11px] text-mist">
            {r.framework} · {r.provider} · {r.model}
          </div>
        </div>
      ),
    },
    { key: 'owners', header: 'Ownership', cell: (r) => <span className="text-xs text-mist">{r.businessOwner} / {r.riskOwner}</span> },
    { key: 'autonomy', header: 'Autonomy', cell: (r) => <span className="font-mono text-xs">{r.autonomyLevel}</span> },
    { key: 'kill', header: 'Kill switch', cell: (r) => <Badge tone={r.killEnabled ? 'ok' : 'warn'}>{r.killEnabled ? 'enabled' : 'read-only agent'}</Badge> },
    { key: 'review', header: 'Next review', cell: (r) => <span className="font-mono text-xs">{fmtTime(r.nextReview)}</span> },
    { key: 'status', header: 'Status', cell: (r) => <Badge tone={STATUS_TONE[r.status] ?? 'info'}>{r.status}</Badge> },
  ];

  return (
    <Card title={`Agent passports · ${rows.length}`} subtitle="One passport per agent: owner, model, modalities, authority and review dates.">
      <Table rows={rows} columns={columns} rowKey={(r) => r.agentId} label="Agent passports" />
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* passport detail                                                     */
/* ------------------------------------------------------------------ */

interface AgentDetail {
  passport: RegistryRow;
  blastRadius: BlastRadius;
  breaches?: { ok: boolean; breaches: BlastBreach[]; remainingTodayUsd: number } | BlastBreach[];
  incidents: IncidentRow[];
  decisions: DecisionRow[];
  agentState?: { status: string; killedAt: number | null };
}

export function PassportDetailPage({ agentId }: { agentId: string }) {
  const ep = useEndpoint<AgentDetail>(`/agents/${encodeURIComponent(agentId)}`);
  const navigate = useNavigate();
  const early = earlyState(ep, 'Loading passport…');
  if (early) return early;
  const { passport: p, blastRadius: blast, incidents, decisions } = ep.data!;
  const now = Date.now();

  const approved = p.approvedCapabilities;
  const effective = p.effectiveCapabilities;
  const beyondApproval = effective.filter((c) => !approved.includes(c));
  const overdueDays = p.nextReview < now ? Math.round((now - p.nextReview) / 86_400_000) : 0;
  const credentialValid = p.credentialExpiry > now;
  const agentStatus = ep.data!.agentState?.status ?? p.status;

  const recentDecisions = [...decisions].sort((a, b) => b.ts - a.ts).slice(0, 12);

  const incidentColumns: Array<Column<IncidentRow>> = [
    { key: 'id', header: 'Incident', cell: (i) => <span className="font-mono text-xs">{i.id}</span> },
    { key: 'type', header: 'Type', cell: (i) => <span className="text-xs">{i.type}</span> },
    { key: 'severity', header: 'Severity', cell: (i) => <Badge tone={riskTone(i.severity)}>{i.severity}</Badge> },
    { key: 'title', header: 'Title', cell: (i) => <span className="text-xs text-mist">{i.title}</span> },
    { key: 'status', header: 'Status', cell: (i) => <Badge tone={i.status === 'Closed' || i.status === 'Resolved' ? 'ok' : 'warn'}>{i.status}</Badge> },
  ];

  const decisionColumns: Array<Column<DecisionRow>> = [
    { key: 'ts', header: 'When', cell: (d) => <span className="font-mono text-xs">{fmtTime(d.ts)}</span> },
    { key: 'action', header: 'Action', cell: (d) => <span className="font-mono text-xs">{d.action}</span> },
    { key: 'decision', header: 'Decision', cell: (d) => <Badge tone={d.decision === 'ALLOW' ? 'ok' : d.decision === 'BLOCK' || d.decision === 'QUARANTINE' ? 'bad' : 'warn'}>{d.decision}</Badge> },
    { key: 'amount', header: 'Amount', cell: (d) => <span className="font-mono text-xs">{d.amountUsd ? fmtUsd(d.amountUsd) : '—'}</span> },
    { key: 'reasons', header: 'Reason codes', cell: (d) => <Chips items={d.reasonCodes} tone={d.decision === 'ALLOW' ? 'ok' : 'warn'} /> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <a
            href="/agent-control-tower/passports"
            onClick={(e) => {
              e.preventDefault();
              navigate('/agent-control-tower/passports');
            }}
            className="text-xs text-mist hover:text-mint"
          >
            ← all passports
          </a>
          <h2 className="text-xl font-semibold text-slate-soft">{p.name}</h2>
          <p className="font-mono text-xs text-mist">
            {p.agentId} · {p.agentVersion} · {p.framework} · {p.provider} / {p.model}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={STATUS_TONE[agentStatus] ?? 'info'}>{agentStatus}</Badge>
          <Badge tone={riskTone(p.riskTier)}>{p.riskTier} risk</Badge>
          <Badge tone="info">{p.autonomyLevel}</Badge>
          <Badge tone={levelTone(blast.overall)}>{blast.overall} blast radius</Badge>
        </div>
      </div>

      <Card title="Identity & ownership">
        <Fields
          items={[
            { label: 'Business function', value: p.businessFunction },
            { label: 'Business owner', value: p.businessOwner },
            { label: 'Technical owner', value: p.technicalOwner },
            { label: 'Risk owner', value: p.riskOwner },
            { label: 'Environment', value: p.environment },
            { label: 'Data classification', value: p.dataClassification },
            { label: 'Modalities', value: <Chips items={p.modalities} /> },
            { label: 'Connected systems', value: <Chips items={p.connectedSystems} /> },
            { label: 'Owner active', value: p.ownerActive ? <Badge tone="ok">yes</Badge> : <Badge tone="bad">no — orphan</Badge> },
          ]}
        />
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Approved permissions" subtitle="What the passport authorizes.">
          <Chips items={approved} tone="ok" />
          <div className="mt-4 text-xs uppercase tracking-wider text-mist">Effective permissions</div>
          <div className="mt-2">
            <Chips items={effective} tone={beyondApproval.length ? 'bad' : 'ok'} />
          </div>
          {beyondApproval.length > 0 ? (
            <p className="mt-3 border-l-2 border-danger/60 pl-3 text-xs text-danger">
              Privilege drift: {beyondApproval.join(', ')} are effective but not approved — an incident is open
              while this persists.
            </p>
          ) : (
            <p className="mt-3 text-xs text-mist">Effective permissions match the approval — no privilege drift.</p>
          )}

          <div className="mt-4 text-xs uppercase tracking-wider text-mist">Prohibited capabilities</div>
          <div className="mt-2">
            <Chips items={p.prohibitedCapabilities} tone="bad" />
          </div>
        </Card>

        <Card title="Authority, credential & review">
          <Fields
            items={[
              {
                label: 'Execution limits',
                value: p.execution && p.execution.length > 0 ? (
                  <span className="font-mono text-xs">
                    {p.execution.map((e) => `${e.capability}: max ${fmtUsd(e.maxAutonomousUsd ?? 0)} · approve > ${fmtUsd(e.autoApprovalThresholdUsd ?? 0)} · ceiling ${fmtUsd(e.authorityCeilingUsd ?? 0)}`).join(' · ')}
                  </span>
                ) : (
                  'no autonomous write authority'
                ),
              },
              { label: 'Daily limit', value: p.dailyLimitUsd ? fmtUsd(p.dailyLimitUsd) : 'none' },
              { label: 'Velocity limit', value: p.velocityPerHour ? `${p.velocityPerHour} / hour` : 'none' },
              {
                label: 'Human approval bands',
                value: p.humanApproval && p.humanApproval.length ? (
                  <span className="font-mono text-xs">{p.humanApproval.map((h) => `${h.capability} ${fmtUsd(h.fromUsd)}–${fmtUsd(h.toUsd)}`).join(' · ')}</span>
                ) : 'none configured',
              },
              {
                label: 'Credential',
                value: (
                  <span>
                    {p.credentialType} · expires <span className="font-mono">{fmtTime(p.credentialExpiry)}</span>{' '}
                    <Badge tone={credentialValid ? 'ok' : 'bad'}>{credentialValid ? 'valid' : 'expired'}</Badge>
                  </span>
                ),
              },
              { label: 'Last review', value: <span className="font-mono">{fmtTime(p.lastReview)}</span> },
              {
                label: 'Next review',
                value: (
                  <span>
                    <span className="font-mono">{fmtTime(p.nextReview)}</span>{' '}
                    {overdueDays > 0 ? <Badge tone="bad">overdue {overdueDays}d</Badge> : <Badge tone="ok">current</Badge>}
                  </span>
                ),
              },
              {
                label: 'Kill capability',
                value: (
                  <span>
                    {p.killEnabled ? <Badge tone="ok">kill switch enabled</Badge> : <Badge tone="info">read-only — no kill needed</Badge>}{' '}
                    <span className="text-xs text-mist">executes outside the agent runtime</span>
                  </span>
                ),
              },
              {
                label: 'Runtime state',
                value: (
                  <span>
                    <Badge tone={STATUS_TONE[agentStatus] ?? 'info'}>{agentStatus}</Badge>{' '}
                    {ep.data!.agentState?.killedAt ? <span className="text-xs text-mist">killed {fmtTime(ep.data!.agentState.killedAt)}</span> : null}
                  </span>
                ),
              },
              { label: 'Cross-border / cross-entity', value: `${p.crossBorderAllowed ? 'allowed' : 'prohibited'} / ${p.crossEntityAllowed ? 'allowed' : 'prohibited'}` },
              { label: 'Approved beneficiaries', value: <Chips items={p.approvedBeneficiaries ?? []} tone="ok" /> },
            ]}
          />
        </Card>
      </div>

      <Card title="Blast radius" subtitle={blast.explanation}>
        <div className="mb-3 flex items-center gap-3">
          <Badge tone={levelTone(blast.overall)}>{blast.overall}</Badge>
          <span className="font-mono text-sm text-slate-soft">
            {blast.financialUsd ? `${fmtUsd(blast.financialUsd)} / day financial exposure` : 'no financial capability'}
          </span>
        </div>
        <Table
          rows={blast.dimensions}
          columns={[
            { key: 'dimension', header: 'Dimension', cell: (d) => <span className="text-xs uppercase tracking-wider text-mist">{d.dimension}</span> },
            { key: 'level', header: 'Level', cell: (d) => <Badge tone={levelTone(d.level)}>{d.level}</Badge> },
            { key: 'value', header: 'Value', cell: (d) => <span className="font-mono text-xs text-slate-soft">{d.value}</span> },
            { key: 'why', header: 'Basis', cell: (d) => <span className="block max-w-2xl text-xs text-mist">{d.explanation}</span> },
          ]}
          rowKey={(d) => d.dimension}
          label="Blast radius dimensions"
        />
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title={`Incidents for ${p.name}`}>
          <Table
            rows={incidents}
            columns={incidentColumns}
            rowKey={(i) => i.id}
            label="Agent incidents"
            empty={<p className="text-sm text-mist">No incidents recorded for this agent.</p>}
          />
        </Card>
        <Card title={`Recent decisions for ${p.name}`}>
          <Table
            rows={recentDecisions}
            columns={decisionColumns}
            rowKey={(d) => d.id}
            label="Agent decisions"
            empty={<p className="text-sm text-mist">No decisions recorded for this agent.</p>}
          />
        </Card>
      </div>
    </div>
  );
}