/**
 * Risk Appetite (§50), AI Use Cases (§51) and Technology Suitability (§52).
 *
 * Appetite rows carry their own assessment (WITHIN / OUTSIDE / EXCEPTION) and
 * use cases show inherent vs residual risk plus the recommended operating
 * mode. Technology suitability states which technology fits which job —
 * deterministic controls keep authorization, models keep planning.
 */

import type { AppetiteItem, UseCase } from '@promptslim/act';
import { useEndpoint } from '../data';
import { Badge, Card, Chips, earlyState, Table } from '../ui';
import type { Column } from '../ui';

/* ------------------------------------------------------------------ */
/* risk appetite                                                       */
/* ------------------------------------------------------------------ */

const APPETITE_TONE: Record<AppetiteItem['assessment'], 'ok' | 'warn' | 'bad'> = {
  'WITHIN APPETITE': 'ok',
  'OUTSIDE APPETITE': 'bad',
  EXCEPTION: 'warn',
};

export function AppetitePage() {
  const ep = useEndpoint<AppetiteItem[]>('/appetite');
  const early = earlyState(ep, 'Loading risk appetite…');
  if (early) return early;
  const rows = ep.data!;

  const columns: Array<Column<AppetiteItem>> = [
    { key: 'label', header: 'Appetite statement', cell: (a) => <span className="text-slate-soft">{a.label}</span> },
    { key: 'configured', header: 'Configured limit', cell: (a) => <span className="text-xs text-mist">{a.configured}</span> },
    {
      key: 'assessment',
      header: 'Assessment',
      cell: (a) => <Badge tone={APPETITE_TONE[a.assessment]}>{a.assessment}</Badge>,
    },
    { key: 'detail', header: 'Detail', cell: (a) => <span className="block max-w-2xl text-xs text-mist">{a.detail}</span> },
  ];

  const counts = {
    within: rows.filter((r) => r.assessment === 'WITHIN APPETITE').length,
    outside: rows.filter((r) => r.assessment === 'OUTSIDE APPETITE').length,
    exception: rows.filter((r) => r.assessment === 'EXCEPTION').length,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Badge tone="ok">{counts.within} within appetite</Badge>
        <Badge tone="bad">{counts.outside} outside appetite</Badge>
        <Badge tone="warn">{counts.exception} exception</Badge>
      </div>
      <Card
        title={`Risk appetite · ${rows.length} statements`}
        subtitle="An appetite breach is a governed state (exception with an expiry, or an incident) — never a silent override."
      >
        <Table rows={rows} columns={columns} rowKey={(a) => a.key} label="Risk appetite" />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AI use cases + technology suitability                               */
/* ------------------------------------------------------------------ */

interface SuitabilityRow {
  use: string;
  best: 'LLM' | 'rules engine' | 'traditional ML' | 'hybrid' | 'human workflow';
  why: string;
  runnersUp: string[];
}

const SUIT_TONE: Record<SuitabilityRow['best'], 'ok' | 'warn' | 'bad' | 'info'> = {
  LLM: 'ok',
  hybrid: 'ok',
  'rules engine': 'warn',
  'traditional ML': 'info',
  'human workflow': 'info',
};

export function UseCasesPage() {
  const uc = useEndpoint<UseCase[]>('/use-cases');
  const su = useEndpoint<SuitabilityRow[]>('/use-cases/suitability');

  const early = earlyState(uc, 'Loading AI use cases…');
  if (early) return early;
  const rows = uc.data!;
  const suitability = su.data ?? [];

  const suitColumns: Array<Column<SuitabilityRow>> = [
    { key: 'use', header: 'Use', cell: (s) => <span className="text-slate-soft">{s.use}</span> },
    { key: 'best', header: 'Best fit', cell: (s) => <Badge tone={SUIT_TONE[s.best]}>{s.best}</Badge> },
    { key: 'why', header: 'Why', cell: (s) => <span className="block max-w-xl text-xs text-mist">{s.why}</span> },
    {
      key: 'runners',
      header: 'Runners-up',
      cell: (s) => <Chips items={s.runnersUp} tone="info" />,
    },
  ];

  return (
    <div className="space-y-4">
      <Card
        title={`AI use cases · ${rows.length}`}
        subtitle="Inherent risk before controls, residual risk after them, and the operating mode that is actually recommended."
      >
        <div className="space-y-4">
          {rows.map((u) => (
            <div key={u.id} className="border border-line bg-ink-900/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-soft">{u.name}</div>
                  <div className="text-xs text-mist">{u.objective}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={u.recommendedMode === 'PROHIBITED' ? 'bad' : u.recommendedMode === 'HUMAN APPROVAL' ? 'warn' : 'ok'}>
                    {u.recommendedMode}
                  </Badge>
                  <Badge tone={u.status === 'approved' ? 'ok' : u.status === 'rejected' ? 'bad' : 'warn'}>{u.status}</Badge>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-4">
                <div>
                  <div className="uppercase tracking-wider text-mist">Materiality</div>
                  <div className="text-slate-soft">{u.materiality}</div>
                </div>
                <div>
                  <div className="uppercase tracking-wider text-mist">Exposure</div>
                  <div className="font-mono text-slate-soft">${u.financialExposureUsd.toLocaleString('en-US')}</div>
                </div>
                <div>
                  <div className="uppercase tracking-wider text-mist">Customer impact</div>
                  <div className="text-slate-soft">{u.customerImpact}</div>
                </div>
                <div>
                  <div className="uppercase tracking-wider text-mist">Data</div>
                  <div className="text-slate-soft">{u.dataSensitivity}</div>
                </div>
                <div>
                  <div className="uppercase tracking-wider text-mist">Inherent risk</div>
                  <Badge tone={u.inherentRisk === 'critical' ? 'bad' : u.inherentRisk === 'high' ? 'warn' : 'info'}>
                    {u.inherentRisk}
                  </Badge>
                </div>
                <div>
                  <div className="uppercase tracking-wider text-mist">Residual risk</div>
                  <Badge tone={u.residualRisk === 'critical' ? 'bad' : u.residualRisk === 'high' ? 'warn' : 'ok'}>
                    {u.residualRisk}
                  </Badge>
                </div>
                <div>
                  <div className="uppercase tracking-wider text-mist">Reversibility</div>
                  <div className="text-mist">{u.reversibility}</div>
                </div>
                <div>
                  <div className="uppercase tracking-wider text-mist">Oversight</div>
                  <div className="text-mist">{u.oversight}</div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-4 text-xs text-mist">
                <span>
                  <span className="uppercase tracking-wider">Modalities: </span>
                  <Chips items={u.modalities} />
                </span>
                <span>
                  <span className="uppercase tracking-wider">Systems: </span>
                  <span className="font-mono">{u.systems.join(', ')}</span>
                </span>
                <span>
                  <span className="uppercase tracking-wider">Jurisdictions: </span>
                  <span className="font-mono">{u.jurisdictions.join(', ')}</span>
                </span>
              </div>
              <div className="mt-2 text-xs text-mist">
                <span className="uppercase tracking-wider">Controls: </span>
                {u.controls.join(' · ')}
              </div>
              <div className="mt-1 text-xs text-mist">
                <span className="uppercase tracking-wider">Value: </span>
                {u.value}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="Technology Suitability (§52)"
        subtitle="Which technology actually fits the job — runners-up included."
      >
        {su.blocked ? (
          <p className="text-sm text-mist">&ldquo;{su.blocked}&rdquo;</p>
        ) : su.error ? (
          <p className="text-sm text-danger">{su.error}</p>
        ) : suitability.length === 0 ? (
          <p className="font-mono text-sm text-mist">Loading suitability table…</p>
        ) : (
          <>
            <Table rows={suitability} columns={suitColumns} rowKey={(s) => s.use} label="Technology suitability" />
            <p className="mt-3 border-l-2 border-amber-soft/50 pl-3 text-sm text-mist">
              Suitability is a contrast, not a ranking: an LLM is right for
              planning, drafting and synthesis, while transaction authorization stays with a
              deterministic rules engine — see the seeded &ldquo;Transaction authorization&rdquo; row,
              where the best fit is <span className="font-mono text-amber-soft">rules engine</span>.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}