/**
 * Framework Mapping — CONTROL MAPPING ONLY, with evidence and gaps.
 *
 * Tabs: FSB 12 sound practices, MAS SAFR, NIST / ISO / OWASP + customer
 * controls. Status vocabulary is fixed: Strongly Evidenced, Partially
 * Evidenced, Gap, Not Assessed, External Process Required. The threat model
 * and the SIEM event catalog live alongside the mappings.
 */

import { useState } from 'react';
import { SIEM_EVENTS, threatModel } from '@promptslim/act';
import type { Framework, MappedControl, MappingStatus } from '@promptslim/act';
import { useEndpoint } from '../data';
import { Badge, Card, earlyState, Table } from '../ui';
import type { Column } from '../ui';

interface FrameworksPayload {
  frameworks: Framework[];
  summaries?: Record<string, Record<string, number>>;
  disclaimer?: string;
}

const STATUS_TONE: Record<MappingStatus, 'ok' | 'warn' | 'bad' | 'info'> = {
  'Strongly Evidenced': 'ok',
  'Partially Evidenced': 'warn',
  Gap: 'bad',
  'Not Assessed': 'info',
  'External Process Required': 'info',
};

const TABS: Array<{ key: string; label: string }> = [
  { key: 'fsb', label: 'FSB 12' },
  { key: 'mas', label: 'MAS SAFR' },
  { key: 'standards', label: 'NIST-ISO-OWASP' },
];

const SEVERITY_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info'> = {
  low: 'info',
  medium: 'warn',
  high: 'warn',
  critical: 'bad',
};

export function FrameworksPage() {
  const ep = useEndpoint<FrameworksPayload>('/frameworks');
  const [activeKey, setActiveKey] = useState('fsb');

  const early = earlyState(ep, 'Loading framework mapping…');
  if (early) return early;
  const { frameworks } = ep.data!;

  const active = frameworks.find((f) => f.key === activeKey) ?? frameworks[0];
  const controls = active.controls;
  const counts = {
    total: controls.length,
    strongly: controls.filter((c) => c.status === 'Strongly Evidenced').length,
    partial: controls.filter((c) => c.status === 'Partially Evidenced').length,
    gap: controls.filter((c) => c.status === 'Gap').length,
    notAssessed: controls.filter((c) => c.status === 'Not Assessed').length,
    external: controls.filter((c) => c.status === 'External Process Required').length,
  };

  const columns: Array<Column<MappedControl>> = [
    { key: 'id', header: 'Control', cell: (c) => <span className="font-mono text-xs text-mist">{c.id}</span> },
    {
      key: 'title',
      header: 'Practice / requirement',
      cell: (c) => (
        <div>
          <div className="text-sm text-slate-soft">{c.title}</div>
          <div className="text-[11px] text-mist">owner: {c.owner} · assessed {c.lastAssessedDays}d ago</div>
        </div>
      ),
    },
    { key: 'status', header: 'Evidence status', cell: (c) => <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge> },
    { key: 'controls', header: 'Controls', cell: (c) => <span className="block max-w-64 text-xs text-mist">{c.controls.join(' · ') || '—'}</span> },
    { key: 'evidence', header: 'Evidence', cell: (c) => <span className="block max-w-64 text-xs text-mist">{c.evidence.join(' · ') || '—'}</span> },
    {
      key: 'gaps',
      header: 'Gaps',
      cell: (c) => <span className="block max-w-64 text-xs text-amber-soft/90">{c.gaps.join(' · ') || 'none recorded'}</span>,
    },
    { key: 'rec', header: 'Recommendation', cell: (c) => <span className="block max-w-64 text-xs text-mist">{c.recommendation}</span> },
  ];

  const threatColumns: Array<Column<ReturnType<typeof threatModel>[number]>> = [
    { key: 'threat', header: 'Threat', cell: (t) => <span className="text-xs text-slate-soft">{t.threat}</span> },
    { key: 'asset', header: 'Asset', cell: (t) => <span className="text-xs text-mist">{t.asset}</span> },
    { key: 'path', header: 'Attack path', cell: (t) => <span className="block max-w-56 text-xs text-mist">{t.attackPath}</span> },
    { key: 'prevention', header: 'Prevention', cell: (t) => <span className="block max-w-56 text-xs text-mist">{t.prevention}</span> },
    { key: 'detection', header: 'Detection', cell: (t) => <span className="block max-w-48 text-xs text-mist">{t.detection}</span> },
    { key: 'containment', header: 'Containment', cell: (t) => <span className="block max-w-48 text-xs text-mist">{t.containment}</span> },
    { key: 'evidence', header: 'Evidence', cell: (t) => <span className="block max-w-48 text-xs text-mist">{t.evidence}</span> },
    { key: 'residual', header: 'Residual risk', cell: (t) => <span className="block max-w-56 text-xs text-amber-soft/90">{t.residual}</span> },
  ];

  return (
    <div className="space-y-4">
      <Card title="Control mapping" subtitle={ep.data!.disclaimer ?? 'Status describes evidence availability in this deployment.'}>
        <div className="mb-4 flex flex-wrap gap-2">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveKey(tab.key)}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                active.key === tab.key
                  ? 'border-mint/50 bg-mint/10 text-mint'
                  : 'border-line bg-ink-900 text-mist hover:border-mint/30'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="mb-3 flex flex-wrap gap-2">
          <Badge tone="info">{counts.total} mapped</Badge>
          <Badge tone="ok">{counts.strongly} Strongly Evidenced</Badge>
          <Badge tone="warn">{counts.partial} Partially Evidenced</Badge>
          <Badge tone="bad">{counts.gap} Gap</Badge>
          <Badge tone="info">{counts.notAssessed} Not Assessed</Badge>
          <Badge tone="info">{counts.external} External Process Required</Badge>
        </div>

        <p className="mb-4 text-sm text-mist">{active.note}</p>

        <Table rows={controls} columns={columns} rowKey={(c) => c.id} label={`${active.name} controls`} />

        <p className="mt-3 text-xs text-mist">{active.name}</p>
      </Card>

      <Card title="Threat model" subtitle="Prevention, detection, containment and the residual risk we do not claim to remove.">
        <Table rows={threatModel()} columns={threatColumns} rowKey={(t) => t.threat} label="Threat model" />
      </Card>

      <Card title="SIEM event catalog" subtitle="Structured events streamed to the customer SIEM (§76).">
        <Table
          rows={SIEM_EVENTS}
          columns={[
            { key: 'event', header: 'Event', cell: (e) => <span className="font-mono text-xs text-slate-soft">{e.event}</span> },
            { key: 'severity', header: 'Severity', cell: (e) => <Badge tone={SEVERITY_TONE[e.severity] ?? 'info'}>{e.severity}</Badge> },
            { key: 'description', header: 'Description', cell: (e) => <span className="text-xs text-mist">{e.description}</span> },
          ]}
          rowKey={(e) => e.event}
          label="SIEM events"
        />
      </Card>
    </div>
  );
}