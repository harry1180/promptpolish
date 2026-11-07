/**
 * Policy Studio (§42/§43 lifecycle) + What-If Simulator.
 *
 * Policy Studio shows the maker-checker lifecycle strip, the controlled
 * learning strip, per-row state and WHO did what (proposer → reviewer →
 * approver). Approve/Publish enforce segregation of duties SERVER-side: a
 * 403/409 answer is surfaced inline as a notice line, never as a crash, and
 * the list is refetched afterwards.
 */

import { useState } from 'react';
import type {
  ContentClass, EvaluationContext, GovernanceDecision, ModalityClass, PolicyRow,
  ProvenanceState, RegistryRow, TrustLevel,
} from '@promptslim/act';
import { post } from '../api';
import { useEndpoint } from '../data';
import { Badge, Card, Chips, DecisionBadge, earlyState, SectionTitle, Table } from '../ui';
import type { Column } from '../ui';

interface Lifecycle {
  policy: string[];
  learning: string[];
  rules: string[];
  suitabilityCriteria?: string[];
}

const STATE_TONE: Record<PolicyRow['state'], 'ok' | 'warn' | 'bad' | 'info'> = {
  Active: 'ok',
  Approved: 'ok',
  'In Review': 'warn',
  Draft: 'info',
  Superseded: 'info',
};

function Strip({ title, steps, tone = 'info' }: { title: string; steps: string[]; tone?: 'ok' | 'warn' | 'info' }) {
  const toneClass = tone === 'ok' ? 'border-mint/40 text-mint' : tone === 'warn' ? 'border-amber-soft/40 text-amber-soft' : 'border-line text-slate-soft';
  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-wider text-mist">{title}</div>
      <ol className="flex flex-wrap items-center gap-1.5">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className={`rounded-md border bg-ink-900 px-2 py-1 font-mono text-xs ${toneClass}`}>{s}</span>
            {i < steps.length - 1 && <span className="text-mist/60">→</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* policy studio                                                       */
/* ------------------------------------------------------------------ */

function actorFor(row: PolicyRow): string {
  return row.reviewer ?? row.approver ?? 'r.okafor';
}

export function PolicyStudioPage() {
  const ep = useEndpoint<PolicyRow[]>('/policies');
  const lc = useEndpoint<Lifecycle>('/policies/lifecycle');
  const [rows, setRows] = useState<PolicyRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const early = earlyState(ep, 'Loading policy studio…');
  if (early) return early;
  const data = rows ?? ep.data!;
  const lifecycle = lc.data;

  async function act(id: string, kind: 'approve' | 'publish') {
    const row = data.find((r) => r.id === id);
    if (!row) {
      setNotice({ tone: 'bad', text: `unknown policy ${id}` });
      return;
    }
    const actor = actorFor(row);
    setBusy(id + kind);
    setNotice(null);
    try {
      await post(`/demo/policies/${encodeURIComponent(id)}/${kind}`, { actor });
      setNotice({ tone: 'ok', text: `${id} ${kind === 'approve' ? 'approved' : 'published'} by ${actor}.` });
    } catch (err) {
      // maker-checker rejections (403 segregation of duties / 409 wrong state)
      setNotice({ tone: 'bad', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      setRows(null);
      ep.reload();
    }
  }

  const columns: Array<Column<PolicyRow>> = [
    {
      key: 'id',
      header: 'Policy',
      cell: (r) => (
        <div>
          <span className="font-mono text-xs text-slate-soft">{r.id}</span>
          <div className="text-xs text-mist">{r.name}</div>
        </div>
      ),
    },
    { key: 'version', header: 'Version', cell: (r) => <span className="font-mono text-xs">{r.version}</span> },
    { key: 'scope', header: 'Scope', cell: (r) => <span className="text-[11px] text-mist">{r.scope}</span> },
    { key: 'state', header: 'State', cell: (r) => <Badge tone={STATE_TONE[r.state]}>{r.state}</Badge> },
    { key: 'priority', header: 'Priority', cell: (r) => <span className="font-mono text-xs">{r.priority}</span> },
    {
      key: 'who',
      header: 'Maker → checker',
      cell: (r) => (
        <div className="text-[11px] leading-4 text-mist">
          <div>
            proposed <span className="text-slate-soft">{r.proposer}</span>
          </div>
          <div>
            reviewed {r.reviewer ? <span className="text-slate-soft">{r.reviewer}</span> : '—'}
          </div>
          <div>
            approved {r.approver ? <span className="text-slate-soft">{r.approver}</span> : '—'}
          </div>
        </div>
      ),
    },
    { key: 'updated', header: 'Updated', cell: (r) => <span className="font-mono text-xs">{r.updatedDays}d ago</span> },
    {
      key: 'tests',
      header: 'Tests',
      cell: (r) => <Badge tone={r.tests === 'passing' ? 'ok' : r.tests === 'failing' ? 'bad' : 'info'}>{r.tests}</Badge>,
    },
    {
      key: 'actions',
      header: 'Lifecycle',
      cell: (r) => {
        const frozen = r.state === 'Active' || r.state === 'Superseded';
        return (
          <span className="flex gap-2">
            <button
              type="button"
              disabled={frozen || busy !== null}
              onClick={() => void act(r.id, 'approve')}
              className="rounded-md border border-mint/40 bg-mint/10 px-2.5 py-1 text-xs text-mint disabled:opacity-40"
              title={`Approve as ${actorFor(r)}`}
            >
              {busy === r.id + 'approve' ? 'approving…' : 'Approve'}
            </button>
            <button
              type="button"
              disabled={frozen || busy !== null}
              onClick={() => void act(r.id, 'publish')}
              className="rounded-md border border-amber-soft/40 bg-amber-soft/10 px-2.5 py-1 text-xs text-amber-soft disabled:opacity-40"
              title={`Publish as ${actorFor(r)}`}
            >
              {busy === r.id + 'publish' ? 'publishing…' : 'Publish'}
            </button>
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      {notice && (
        <p
          role={notice.tone === 'bad' ? 'alert' : 'status'}
          className={`card px-4 py-3 font-mono text-sm ${notice.tone === 'bad' ? 'border-danger/50 text-danger' : 'border-mint/40 text-mint'}`}
        >
          {notice.text}
        </p>
      )}

      <Card
        title="Policy lifecycle"
        subtitle="Authors cannot approve their own changes: every transition is maker-checker and lands in the evidence ledger."
      >
        {lifecycle ? (
          <div className="space-y-5">
            <Strip title="Maker-checker lifecycle" steps={lifecycle.policy} tone="ok" />
            <Strip title="Controlled learning (§54)" steps={lifecycle.learning} tone="warn" />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <div className="mb-2 text-[11px] uppercase tracking-wider text-mist">Rules</div>
                <ul className="space-y-1 text-sm text-mist">
                  {lifecycle.rules.map((rule) => (
                    <li key={rule} className="border-b border-line/50 pb-1">
                      {rule}
                    </li>
                  ))}
                </ul>
              </div>
              {(lifecycle.suitabilityCriteria ?? []).length > 0 && (
                <div>
                  <div className="mb-2 text-[11px] uppercase tracking-wider text-mist">Suitability criteria</div>
                  <ul className="space-y-1 text-sm text-mist">
                    {(lifecycle.suitabilityCriteria ?? []).map((c) => (
                      <li key={c} className="border-b border-line/50 pb-1">
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        ) : lc.blocked ? (
          <p className="text-sm text-mist">&ldquo;{lc.blocked}&rdquo;</p>
        ) : lc.error ? (
          <p className="text-sm text-danger">{lc.error}</p>
        ) : (
          <p className="font-mono text-sm text-mist">Loading lifecycle…</p>
        )}
      </Card>

      <Card
        title={`Policies · ${data.length}`}
        subtitle="Lifecycle state per policy with proposer, reviewer and approver. Approve/Publish act as the row's checker."
        actions={
          <button
            type="button"
            onClick={() => {
              setRows(null);
              ep.reload();
            }}
            className="rounded-md border border-line bg-ink-700 px-3 py-1 text-xs text-slate-soft hover:border-mint/40"
          >
            Refresh
          </button>
        }
      >
        <Table rows={data} columns={columns} rowKey={(r) => r.id} label="Policy lifecycle" />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* what-if simulator                                                   */
/* ------------------------------------------------------------------ */

const MODALITIES: ModalityClass[] = [
  'TEXT', 'DOCUMENT', 'IMAGE', 'AUDIO', 'VOICE', 'VIDEO', 'LIVE VIDEO', 'MULTIMODAL',
  'CODE', 'STRUCTURED DATA', 'EXTERNAL WEB CONTENT', 'TOOL OUTPUT', 'AGENT MESSAGE',
];
const TRUSTS: TrustLevel[] = ['trusted', 'internal', 'external', 'unknown', 'untrusted'];
const PROVENANCES: ProvenanceState[] = ['valid', 'invalid', 'absent', 'unknown', 'partial'];
const CLASSES: ContentClass[] = [
  'User Instruction', 'System Instruction', 'Enterprise Policy', 'Retrieved Context',
  'External Content', 'Tool Result', 'Agent Message',
];

interface WhatIfResult {
  context: EvaluationContext;
  decision: GovernanceDecision;
  explanation: string[];
}

const FIELD =
  'w-full rounded-md border border-line bg-ink-900 px-2 py-1.5 font-mono text-xs text-slate-soft';

export function WhatIfPage() {
  const agents = useEndpoint<RegistryRow[]>('/agents');
  const [agentId, setAgentId] = useState('');
  const [action, setAction] = useState('');
  const [amount, setAmount] = useState('');
  const [modality, setModality] = useState<ModalityClass>('STRUCTURED DATA');
  const [sourceTrust, setSourceTrust] = useState<TrustLevel>('internal');
  const [provenance, setProvenance] = useState<ProvenanceState>('unknown');
  const [contentClass, setContentClass] = useState<ContentClass>('System Instruction');
  const [beneficiary, setBeneficiary] = useState<'approved' | 'new' | 'none'>('approved');
  const [injection, setInjection] = useState(false);
  const [identityClaim, setIdentityClaim] = useState(false);
  const [crossEntity, setCrossEntity] = useState(false);
  const [reversible, setReversible] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [velocity, setVelocity] = useState('0');
  const [dailyUsed, setDailyUsed] = useState('0');
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const early = earlyState(agents, 'Loading agents…');
  if (early) return early;
  const list = agents.data!;
  const selected = list.find((a) => a.agentId === agentId) ?? list[0];
  const exec = selected?.execution?.[0];

  async function run() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const now = Date.now();
    const body: EvaluationContext & { credentialValid: boolean } = {
      tenant: 'demo-synthetic-001',
      environment: 'demo',
      agentId: selected.agentId,
      agentVersion: selected.agentVersion,
      authorityProfileVersion: `${selected.agentId}@${selected.agentVersion}`,
      identityVerified: true,
      tenantValid: true,
      credential: { valid: true, expiresAt: now + 900_000 },
      credentialValid: true,
      agentStatus: 'active',
      action: action || selected.approvedCapabilities[0] || 'read:context',
      modality,
      sourceTrust,
      provenance,
      contentClass,
      injectionDetected: injection,
      syntheticMediaRisk: identityClaim ? 'high' : 'none',
      identityClaimViaMedia: identityClaim,
      crossEntity,
      riskTier: selected.riskTier,
      autonomyLevel: selected.autonomyLevel,
      approvedCapabilities: selected.approvedCapabilities,
      prohibitedCapabilities: selected.prohibitedCapabilities,
      amountUsd: amount ? Number(amount) : undefined,
      beneficiary:
        beneficiary === 'none'
          ? undefined
          : beneficiary === 'approved'
            ? { id: 'ben_supplier_4471', approved: true }
            : { id: 'ben_new_9931', approved: false },
      maxAutonomousUsd: exec?.maxAutonomousUsd,
      authorityCeilingUsd: exec?.authorityCeilingUsd,
      autoApprovalThresholdUsd: exec?.autoApprovalThresholdUsd,
      dailyLimitUsd: selected.dailyLimitUsd,
      dailyExecutedUsd: dailyUsed ? Number(dailyUsed) : 0,
      maxVelocityPerHour: selected.velocityPerHour,
      velocityLastHour: velocity ? Number(velocity) : 0,
      reversible,
      readOnly,
      approval: { state: 'none' },
      policyEngineAvailable: true,
      evidenceInfrastructureOk: true,
      productionConfigValid: true,
      now,
    };
    try {
      const res = await post<WhatIfResult>('/demo/whatif', body);
      setResult(res);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card title="What-if input" subtitle="Ask the deterministic gateway what it would decide — no side effects, nothing is executed.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-xs text-mist">
            Agent
            <select
              className={FIELD}
              value={selected?.agentId ?? ''}
              onChange={(e) => {
                setAgentId(e.target.value);
                setAction('');
              }}
            >
              {list.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.name} · {a.autonomyLevel}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-mist">
            Action (capability)
            <input
              className={FIELD}
              list="act-capabilities"
              value={action || selected?.approvedCapabilities[0] || ''}
              onChange={(e) => setAction(e.target.value)}
              placeholder="transfer:execute"
            />
            <datalist id="act-capabilities">
              {selected?.approvedCapabilities.map((c) => <option key={c} value={c} />)}
              {selected?.prohibitedCapabilities.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label className="text-xs text-mist">
            Amount (USD)
            <input
              className={FIELD}
              type="number"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={exec ? String(exec.maxAutonomousUsd ?? 0) : '0'}
            />
          </label>
          <label className="text-xs text-mist">
            Beneficiary
            <select className={FIELD} value={beneficiary} onChange={(e) => setBeneficiary(e.target.value as 'approved' | 'new' | 'none')}>
              <option value="approved">approved (ben_supplier_4471)</option>
              <option value="new">new / not approved</option>
              <option value="none">none</option>
            </select>
          </label>
          <label className="text-xs text-mist">
            Modality
            <select className={FIELD} value={modality} onChange={(e) => setModality(e.target.value as ModalityClass)}>
              {MODALITIES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-mist">
            Source trust
            <select className={FIELD} value={sourceTrust} onChange={(e) => setSourceTrust(e.target.value as TrustLevel)}>
              {TRUSTS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-mist">
            Content class
            <select className={FIELD} value={contentClass} onChange={(e) => setContentClass(e.target.value as ContentClass)}>
              {CLASSES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-mist">
            Provenance
            <select className={FIELD} value={provenance} onChange={(e) => setProvenance(e.target.value as ProvenanceState)}>
              {PROVENANCES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-mist">
            Velocity last hour
            <input className={FIELD} type="number" min={0} value={velocity} onChange={(e) => setVelocity(e.target.value)} />
          </label>
          <label className="text-xs text-mist">
            Already executed today (USD)
            <input className={FIELD} type="number" min={0} value={dailyUsed} onChange={(e) => setDailyUsed(e.target.value)} />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-mist">
          {[
            ['Injection detected', injection, setInjection] as const,
            ['Identity claimed via media', identityClaim, setIdentityClaim] as const,
            ['Cross-entity', crossEntity, setCrossEntity] as const,
            ['Reversible', reversible, setReversible] as const,
            ['Read-only', readOnly, setReadOnly] as const,
          ].map(([label, value, setter]) => (
            <label key={label} className="flex items-center gap-2">
              <input type="checkbox" checked={value} onChange={(e) => setter(e.target.checked)} />
              {label}
            </label>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            disabled={busy || !selected}
            onClick={() => void run()}
            className="rounded-md border border-mint/50 bg-mint/10 px-4 py-2 text-sm text-mint disabled:opacity-50"
          >
            {busy ? 'Evaluating…' : 'Run what-if'}
          </button>
          <span className="text-xs text-mist">
            Server-side passport always wins: limits, capabilities and status are read from the registry, not the form.
          </span>
        </div>
        {error && (
          <p role="alert" className="mt-3 border-l-2 border-danger/60 pl-3 font-mono text-sm text-danger">
            {error}
          </p>
        )}
      </Card>

      <Card title="Decision">
        {!result ? (
          <p className="font-mono text-sm text-mist">
            No simulation yet — choose an agent and run the what-if. The gateway returns ALLOW / HOLD /
            REQUIRE_APPROVAL / BLOCK / QUARANTINE with its matched policies.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <DecisionBadge value={result.decision.decision} />
              <Badge tone="info">severity {result.decision.riskSeverity}</Badge>
              <Badge tone="info">{result.decision.latencyMs} ms</Badge>
              {result.decision.requiredApprover && <Badge tone="warn">approver: {result.decision.requiredApprover}</Badge>}
              <Badge tone={result.decision.failClosed ? 'ok' : 'info'}>
                {result.decision.failClosed ? 'fail-closed' : 'no fail-closed trigger'}
              </Badge>
            </div>

            <p className="text-sm text-slate-soft">{result.decision.summary}</p>

            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-mist">Reason codes</div>
              <Chips items={result.decision.reasonCodes} tone="warn" />
            </div>
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-mist">Matched policies</div>
              <Chips items={result.decision.policyVersions.length ? result.decision.policyVersions : result.decision.policyIds} tone="info" />
            </div>

            <div>
              <SectionTitle title="Explanation" />
              <ol className="space-y-1.5">
                {result.explanation.map((line, i) => (
                  <li key={`${i}-${line}`} className="border-b border-line/50 pb-1.5 text-sm text-mist">
                    {line}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}