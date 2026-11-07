/**
 * Stocks index (/tradingusa/stocks) — the configured universe with live
 * quotes, linking into each stock page. Universe comes from GET /settings,
 * prices from GET /quotes?symbols=…
 */

import { getQuotes, getSettings } from '../api';
import type { QuotesResponse, SettingsResponse } from '../api';
import { Link, useEndpoint } from '../data';
import { Card, DataTable, EmptyState, ErrorState, Loading, money, pct, time, toneClass } from '../ui';

interface UniverseRow {
  ticker: string;
  company: string;
  sector: string;
  price: number | null;
  changePct: number | null;
}

export function StocksPage() {
  const settings = useEndpoint<SettingsResponse>('/settings', getSettings);
  const universe = settings.data?.config?.universe ?? [];
  const symbols = universe.map((u) => u.ticker);
  const key = symbols.length > 0 ? `/quotes?symbols=${symbols.join(',')}` : null;
  const quotes = useEndpoint<QuotesResponse>(key, () => getQuotes(symbols));

  if (settings.data === undefined) {
    return settings.error ? <ErrorState message={settings.error} onRetry={settings.reload} /> : <Loading label="Loading universe…" />;
  }
  if (universe.length === 0) {
    return (
      <EmptyState title="No universe configured">
        GET /settings returned no universe entries, so there are no stock pages to list.
      </EmptyState>
    );
  }

  const bySymbol = new Map((quotes.data?.quotes ?? []).map((q) => [q.symbol, q]));
  const rows: UniverseRow[] = universe.map((u) => {
    const q = bySymbol.get(u.ticker);
    return {
      ticker: u.ticker,
      company: u.company,
      sector: u.sector,
      price: q?.price ?? null,
      changePct: q?.changePct ?? null,
    };
  });

  return (
    <div className="space-y-4">
      <Card title="Universe" subtitle={`${rows.length} instruments · quotes as of ${time(quotes.data?.asOf ?? null)} · click through for the full dossier`}>
        <DataTable
          label="Stock universe"
          rows={rows}
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
            { key: 'sector', header: 'Sector', sortValue: (r) => r.sector, cell: (r) => <span className="text-xs text-mist">{r.sector}</span> },
            { key: 'price', header: 'Price', align: 'right', sortValue: (r) => r.price, cell: (r) => <span className="font-mono">{money(r.price)}</span> },
            {
              key: 'change',
              header: 'Change',
              align: 'right',
              sortValue: (r) => r.changePct,
              cell: (r) => <span className={`font-mono ${toneClass(r.changePct)}`}>{pct(r.changePct)}</span>,
            },
          ]}
        />
      </Card>
    </div>
  );
}