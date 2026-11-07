/**
 * Modality Governance — one gateway for every modality.
 *
 * Renders the content items, the twelve §20 checkpoints per item, the
 * findings and the verdict. Provenance is a TRUST SIGNAL only: absence of
 * Content Credentials never means "fake".
 */

import { useState } from 'react';
import type { Checkpoint, ContentItem, FullModalityReport, ModalityFinding } from '@promptslim/act';
import { useEndpoint } from '../data';
import { Badge, Card, earlyState, fmtTime, Table } from '../ui';
import type { Column } from '../ui';

interface ModalityPayload {
  items: ContentItem[];
  reports: FullModalityReport[];
}

const VERDICT_TONE: Record<string, 'ok' | 'warn' | 'bad'> = {
  PASS: 'ok',
  REVIEW: 'warn',
  BLOCK: 'bad',
};

const CP_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info'> = {
  pass: 'ok',
  attention: 'warn',
  fail: 'bad',
  'not-applicable': 'info',
};

const SEVERITY_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info'> = {
  info: 'info',
  low: 'info',
  medium: 'warn',
  high: 'warn',
  critical: 'bad',
};

export function ModalityPage() {
  const ep = useEndpoint<ModalityPayload>('/modality');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const early = earlyState(ep, 'Loading modality governance…');
  if (early) return early;
  const { items, reports } = ep.data!;

  const activeId = selectedId ?? items[0]?.contentId ?? null;
  const report = reports.find((r) => r.item.contentId === activeId) ?? reports[0];

  const itemColumns: Array<Column<ContentItem>> = [
    {
      key: 'id',
      header: 'Content',
      cell: (c) => (
        <button
          type="button"
          onClick={() => setSelectedId(c.contentId)}
          className={`text-left font-mono text-xs hover:text-mint ${c.contentId === activeId ? 'text-mint' : 'text-slate-soft'}`}
        >
          {c.contentId}
        </button>
      ),
    },
    { key: 'modality', header: 'Modality', cell: (c) => <span className="text-xs">{c.modality}</span> },
    { key: 'source', header: 'Source', cell: (c) => <span className="text-xs text-mist">{c.source}</span> },
    { key: 'class', header: 'Content class', cell: (c) => <span className="text-xs text-mist">{c.contentClass}</span> },
    { key: 'trust', header: 'Trust', cell: (c) => <Badge tone={c.trust === 'trusted' || c.trust === 'internal' ? 'ok' : c.trust === 'untrusted' ? 'bad' : 'warn'}>{c.trust}</Badge> },
    { key: 'injection', header: 'Injection', cell: (c) => <Badge tone={c.injectionRisk === 'detected' ? 'bad' : c.injectionRisk === 'possible' ? 'warn' : 'ok'}>{c.injectionRisk}</Badge> },
    { key: 'synthetic', header: 'Synthetic media', cell: (c) => <Badge tone={c.syntheticMediaState === 'detected' ? 'bad' : c.syntheticMediaState === 'possible' ? 'warn' : 'info'}>{c.syntheticMediaState}</Badge> },
    {
      key: 'verdict',
      header: 'Verdict',
      cell: (c) => {
        const r = reports.find((x) => x.item.contentId === c.contentId);
        return r ? <Badge tone={VERDICT_TONE[r.verdict]}>{r.verdict}</Badge> : <span className="text-mist">—</span>;
      },
    },
    { key: 'ts', header: 'Captured', cell: (c) => <span className="font-mono text-[11px] text-mist">{fmtTime(c.ts)}</span> },
  ];

  const checkpointColumns: Array<Column<Checkpoint>> = [
    { key: 'id', header: '§20 checkpoint', cell: (cp) => <span className="font-mono text-xs text-slate-soft">{cp.label}</span> },
    { key: 'status', header: 'Status', cell: (cp) => <Badge tone={CP_TONE[cp.status] ?? 'info'}>{cp.status}</Badge> },
    { key: 'detail', header: 'Detail', cell: (cp) => <span className="block max-w-3xl text-xs text-mist">{cp.detail}</span> },
  ];

  const findingColumns: Array<Column<ModalityFinding>> = [
    { key: 'code', header: 'Code', cell: (f) => <span className="font-mono text-xs text-slate-soft">{f.code}</span> },
    { key: 'label', header: 'Finding', cell: (f) => <span className="text-xs">{f.label}</span> },
    { key: 'severity', header: 'Severity', cell: (f) => <Badge tone={SEVERITY_TONE[f.severity] ?? 'info'}>{f.severity}</Badge> },
    { key: 'detail', header: 'Evidence detail', cell: (f) => <span className="block max-w-3xl text-xs text-mist">{f.detail}</span> },
  ];

  return (
    <div className="space-y-4">
      <Card title={`Content items · ${items.length}`} subtitle="Every modality passes the same gateway before it reaches a model. Select an item to inspect its checkpoints.">
        <Table rows={items} columns={itemColumns} rowKey={(c) => c.contentId} label="Content items" />
      </Card>

      {report && (
        <>
          <Card
            title={`Modality report · ${report.item.contentId}`}
            subtitle={`${report.item.modality} from ${report.item.source} — captured ${fmtTime(report.item.ts)}`}
            actions={
              <span className="flex gap-2">
                <Badge tone={VERDICT_TONE[report.verdict]}>{report.verdict}</Badge>
                <Badge tone={report.mayInstruct ? 'warn' : 'ok'}>
                  instruction trust: {report.instructionTrust}
                </Badge>
              </span>
            }
          >
            <p className="mb-4 text-sm text-mist">
              {report.mayInstruct
                ? 'This content may inform reasoning; consequential action still passes the runtime gateway.'
                : 'Content may NOT instruct the agent — it is data, not authority.'}
            </p>
            <Table
              rows={report.checkpoints}
              columns={checkpointColumns}
              rowKey={(cp) => cp.id}
              label="Modality checkpoints"
            />
          </Card>

          <Card
            title={`Findings · ${report.findings.length}`}
            subtitle="Injection, surface, provenance and minimization signals for the selected item."
          >
            <Table
              rows={report.findings}
              columns={findingColumns}
              rowKey={(f) => `${f.code}-${f.label}`}
              label="Modality findings"
              empty={<p className="text-sm text-mist">No findings for this item.</p>}
            />
          </Card>
        </>
      )}
    </div>
  );
}