/**
 * Integrations (connector register, DISABLED until approved), Production
 * Readiness (gate checklist) and Administration (roles matrix, segregation
 * of duties, break-glass, audit trail).
 */

import type { Integration, ReadinessGate } from '@promptslim/act';
import { useEndpoint } from '../data';
import { Badge, Bar, Card, Chips, earlyState, fmtTime, Table } from '../ui';
import type { Column } from '../ui';

/* ------------------------------------------------------------------ */
/* integrations                                                        */
/* ------------------------------------------------------------------ */

const RISK_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info'> = {
  critical: 'bad',
  high: 'warn',
  moderate: 'info',
  low: 'ok',
};

export function IntegrationsPage() {
  const ep = useEndpoint<Integration[]>('/integrations');
  const early = earlyState(ep, 'Loading integrations…');
  if (early) return early;
  const rows = ep.data!;
  const enabled = rows.filter((r) => r.enabled).length;

  const columns: Array<Column<Integration>> = [
    {
      key: 'system',
      header: 'System',
      cell: (r) => (
        <div>
          <div className="text-sm text-slate-soft">{r.system}</div>
          <div className="text-[11px] text-mist">{r.category} · {r.capability}</div>
        </div>
      ),
    },
    { key: 'auth', header: 'Auth', cell: (r) => <span className="text-xs text-mist">{r.auth}</span> },
    { key: 'cred', header: 'Credential ref', cell: (r) => <span className="font-mono text-[11px] text-mist">{r.credentialRef}</span> },
    { key: 'risk', header: 'Risk', cell: (r) => <Badge tone={RISK_TONE[r.riskTier] ?? 'info'}>{r.riskTier}</Badge> },
    {
      key: 'state',
      header: 'State',
      cell: (r) => (
        <span className="flex gap-1.5">
          <Badge tone={r.enabled ? 'ok' : 'bad'}>{r.enabled ? 'ENABLED' : 'DISABLED'}</Badge>
          <Badge tone={r.approved ? 'ok' : 'warn'}>{r.approved ? 'approved' : 'not approved'}</Badge>
        </span>
      ),
    },
    { key: 'health', header: 'Health', cell: (r) => <Badge tone={r.health === 'healthy' ? 'ok' : r.health === 'degraded' ? 'warn' : 'info'}>{r.health}</Badge> },
    { key: 'failure', header: 'Failure behaviour', cell: (r) => <span className="block max-w-56 text-xs text-mist">{r.failureBehavior}</span> },
    { key: 'kill', header: 'Kill behaviour', cell: (r) => <span className="block max-w-56 text-xs text-mist">{r.killBehavior}</span> },
    { key: 'review', header: 'Last review', cell: (r) => <span className="font-mono text-xs">{r.lastReviewDays}d ago</span> },
    { key: 'owner', header: 'Owner', cell: (r) => <span className="text-xs text-mist">{r.owner}</span> },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-mist">
        Connectors are registered but <span className="font-mono text-amber-soft">DISABLED</span> by
        default and stay disabled until approved (§105): {enabled} of {rows.length} enabled in this
        deployment. Failure behaviour is fail-closed, never fail-open.
      </p>
      <Card title={`Connector register · ${rows.length}`}>
        <Table rows={rows} columns={columns} rowKey={(r) => r.id} label="Integrations" />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* production readiness                                                */
/* ------------------------------------------------------------------ */

const GATE_TONE: Record<ReadinessGate['status'], 'ok' | 'warn' | 'bad' | 'info'> = {
  PASS: 'ok',
  FAIL: 'bad',
  'NOT TESTED': 'warn',
  'CUSTOMER ACTION REQUIRED': 'warn',
};

interface ReadinessPayload {
  gates: ReadinessGate[];
  note: string;
  readinessPct: number;
  blockers?: string[];
}

export function ReadinessPage() {
  const ep = useEndpoint<ReadinessPayload>('/readiness');
  const early = earlyState(ep, 'Loading readiness…');
  if (early) return early;
  const { gates, note, readinessPct } = ep.data!;
  const blockers = ep.data!.blockers ?? gates.filter((g) => g.mandatory && g.status !== 'PASS').map((g) => g.label);

  const columns: Array<Column<ReadinessGate>> = [
    { key: 'label', header: 'Gate', cell: (g) => <span className="text-sm text-slate-soft">{g.label}</span> },
    { key: 'status', header: 'Status', cell: (g) => <Badge tone={GATE_TONE[g.status]}>{g.status}</Badge> },
    { key: 'mandatory', header: 'Mandatory', cell: (g) => <Badge tone="info">{g.mandatory ? 'yes' : 'no'}</Badge> },
    { key: 'detail', header: 'Detail', cell: (g) => <span className="block max-w-3xl text-xs text-mist">{g.detail}</span> },
  ];

  return (
    <div className="space-y-4">
      <Card title="Readiness">
        <div className="flex items-center gap-4">
          <div className="font-mono text-3xl text-slate-soft">{readinessPct}%</div>
          <div className="flex-1">
            <Bar label="gates passing" value={readinessPct} max={100} display={`${readinessPct}%`} tone={readinessPct >= 90 ? 'ok' : 'warn'} />
          </div>
        </div>
        {blockers.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] uppercase tracking-wider text-mist">Outstanding mandatory gates</div>
            <Chips items={blockers} tone="warn" />
          </div>
        )}
        <p className="mt-3 text-sm text-mist">{note}</p>
      </Card>

      <Card title={`Checklist · ${gates.length} gates`} subtitle="PASS / FAIL / NOT TESTED / CUSTOMER ACTION REQUIRED — status reflects this deployment only.">
        <Table rows={gates} columns={columns} rowKey={(g) => g.id} label="Readiness gates" />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* administration                                                      */
/* ------------------------------------------------------------------ */

interface AdminPayload {
  roles: Array<{ role: string; permissions: string[] }>;
  segregation?: string[];
  breakGlass?: {
    requirements?: string[];
    silent?: boolean;
    active?: boolean;
    lastUsed?: number | null;
  };
  recentAudit?: Array<{ seq: number; ts: number; type: string; hash: string; tenant: string }>;
  generatedAt?: number;
  storePath?: string;
}

export function AdministrationPage() {
  const ep = useEndpoint<AdminPayload>('/admin');
  const early = earlyState(ep, 'Loading administration…');
  if (early) return early;
  const admin = ep.data!;

  const audit = admin.recentAudit ?? [];
  const bg = admin.breakGlass;

  const auditColumns: Array<Column<NonNullable<AdminPayload['recentAudit']>[number]>> = [
    { key: 'seq', header: 'Seq', cell: (a) => <span className="font-mono text-xs text-mist">{a.seq}</span> },
    { key: 'ts', header: 'Time', cell: (a) => <span className="font-mono text-xs">{fmtTime(a.ts)}</span> },
    { key: 'type', header: 'Event', cell: (a) => <span className="text-xs text-slate-soft">{a.type}</span> },
    { key: 'hash', header: 'Hash', cell: (a) => <span className="font-mono text-[11px] text-mint">{a.hash}…</span> },
    { key: 'tenant', header: 'Tenant', cell: (a) => <span className="font-mono text-[11px] text-mist">{a.tenant}</span> },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Roles & permissions" subtitle="Role → permission matrix as enforced by the gateway." className="xl:col-span-2">
          <Table
            rows={admin.roles}
            columns={[
              { key: 'role', header: 'Role', cell: (r) => <span className="text-sm text-slate-soft">{r.role}</span> },
              {
                key: 'perms',
                header: 'Permissions',
                cell: (r) => <Chips items={r.permissions} tone="info" />,
              },
            ]}
            rowKey={(r) => r.role}
            label="Roles matrix"
          />
        </Card>

        <Card title="Break-glass" subtitle="Emergency access is loud, time-boxed and reviewed.">
          <div className="mb-3 flex flex-wrap gap-2">
            <Badge tone={bg?.active ? 'bad' : 'ok'}>{bg?.active ? 'ACTIVE' : 'not active'}</Badge>
            <Badge tone="info">{bg?.silent ? 'silent mode' : 'auditable (not silent)'}</Badge>
            <Badge tone="info">
              last used {bg?.lastUsed ? fmtTime(bg.lastUsed) : 'never'}
            </Badge>
          </div>
          <div className="text-[11px] uppercase tracking-wider text-mist">Requirements</div>
          <ul className="mt-1 space-y-1 text-sm text-mist">
            {(bg?.requirements ?? []).map((r) => (
              <li key={r} className="border-b border-line/50 pb-1">
                {r}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Segregation of duties" className="xl:col-span-1">
          <ul className="space-y-1 text-sm text-mist">
            {(admin.segregation ?? []).map((s) => (
              <li key={s} className="border-b border-line/50 pb-1">
                {s}
              </li>
            ))}
          </ul>
        </Card>

        <Card
          title={`Recent audit trail · ${audit.length}`}
          subtitle={`evidence ledger · ${admin.storePath ?? 'demo store'}${admin.generatedAt ? ` · generated ${fmtTime(admin.generatedAt)}` : ''}`}
          className="xl:col-span-2"
        >
          <Table rows={audit} columns={auditColumns} rowKey={(a) => String(a.seq)} label="Audit trail" />
        </Card>
      </div>
    </div>
  );
}