/**
 * Settings — read-only configuration summary, the configured universe, and
 * the LOCKED execution panel (PAPER_ONLY, no real money, single paper
 * adapter). Nothing here is editable from the browser.
 */

import { getSettings } from '../api';
import type { SettingsResponse } from '../api';
import { Link, useEndpoint } from '../data';
import { Badge, Card, DataTable, ErrorState, Loading, money, number, pctAuto } from '../ui';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1.5 last:border-b-0">
      <span className="text-xs text-mist">{label}</span>
      <span className="font-mono text-xs text-slate-soft">{value}</span>
    </div>
  );
}

export function SettingsPage() {
  const ep = useEndpoint<SettingsResponse>('/settings', getSettings);

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading settings…" />;
  }
  const c = ep.data.config ?? {};
  const locked = ep.data.locked;
  const limits = Object.entries(c.limits ?? {});

  return (
    <div className="space-y-4">
      {/* locked execution panel */}
      <Card title="Execution — locked" className="border-amber-soft/50">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border border-amber-soft/50 bg-amber-soft/10 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-amber-soft">executionMode</div>
            <div className="mt-0.5 font-mono text-sm text-amber-soft">{locked?.executionMode ?? 'PAPER_ONLY'}</div>
          </div>
          <div className="rounded-md border border-line bg-ink-900/70 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-mist">realMoneyEnabled</div>
            <div className="mt-0.5 font-mono text-sm text-mint">{String(locked?.realMoneyEnabled ?? false)}</div>
          </div>
          <div className="rounded-md border border-line bg-ink-900/70 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-mist">brokerAdapters</div>
            <div className="mt-0.5 font-mono text-sm text-slate-soft">
              {(locked?.brokerAdapters ?? []).join(', ') || 'PaperBrokerAdapter'}
            </div>
          </div>
          <div className="rounded-md border border-line bg-ink-900/70 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-mist">RobinhoodAdapter</div>
            <div className="mt-0.5 font-mono text-[11px] text-mist">
              interface prepared, NOT implemented, NOT active
            </div>
          </div>
        </div>
        <p className="mt-2 text-xs text-mist">
          These fields are locked server-side: the browser cannot enable real-money trading, and no live broker
          adapter is registered. Every order below the API layer is simulated by PaperBrokerAdapter.
        </p>
      </Card>

      {/* config summary */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Capital">
          <Row label="Short-term capital" value={money(c.shortTermCapital ?? null)} />
          <Row label="Long-term capital" value={money(c.longTermCapital ?? null)} />
          <Row label="Fill mode" value={c.fillMode ?? '—'} />
          <Row label="LLM value threshold" value={number(c.llmValueThreshold ?? null)} />
        </Card>

        <Card title="Risk parameters">
          <Row label="Risk per trade" value={pctAuto(c.riskPerTradePct ?? null)} />
          <Row label="Max position" value={pctAuto(c.maxPositionPct ?? null)} />
          <Row label="Max sector" value={pctAuto(c.maxSectorPct ?? null)} />
          <Row label="Max correlated" value={pctAuto(c.maxCorrelatedPct ?? null)} />
          <Row label="Min risk/reward" value={pctAuto(c.minRiskRewardPct ?? null)} />
        </Card>
      </div>

      <Card title="Limits" subtitle="DEFAULT_LIMITS as served by GET /settings.">
        {limits.length === 0 ? (
          <p className="text-xs text-mist">No limits published.</p>
        ) : (
          <div className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
            {limits.map(([k, v]) => (
              <Row key={k} label={k} value={typeof v === 'number' ? number(v) : String(v)} />
            ))}
          </div>
        )}
      </Card>

      <Card title="Universe" subtitle={`${(c.universe ?? []).length} tradable/context instruments`}>
        <DataTable
          label="Universe"
          rows={c.universe ?? []}
          rowKey={(r) => r.ticker}
          columns={[
            {
              key: 'ticker',
              header: 'Ticker',
              sortValue: (r) => r.ticker,
              cell: (r) => (
                <Link to={`/tradingusa/stocks/${r.ticker}`} className="font-mono font-semibold text-mint hover:underline">
                  {r.ticker}
                </Link>
              ),
            },
            { key: 'company', header: 'Company', sortValue: (r) => r.company, cell: (r) => <span className="text-xs text-slate-soft">{r.company}</span> },
            { key: 'sector', header: 'Sector', sortValue: (r) => r.sector, cell: (r) => <Badge tone="neutral">{r.sector}</Badge> },
          ]}
          empty={<p className="py-3 text-center text-xs text-mist">No universe configured.</p>}
        />
      </Card>
    </div>
  );
}