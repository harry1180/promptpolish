/**
 * Scanner — the server's scan categories (highest conviction → compounders),
 * each rendered with its server-supplied note. Inclusion is NOT a trade.
 */

import { getScanner } from '../api';
import type { ScannerResponse } from '../api';
import { Link, useEndpoint } from '../data';
import { Badge, Card, EmptyState, ErrorState, Loading, money, number, pct, toneClass } from '../ui';

const CATEGORY_TONE: Record<string, 'pos' | 'neg' | 'warn' | 'info' | 'neutral'> = {
  highest_conviction: 'pos',
  new_momentum: 'pos',
  breakouts: 'pos',
  post_earnings: 'info',
  fundamental_improvement: 'info',
  quality_value: 'info',
  oversold_quality: 'warn',
  deterioration: 'neg',
  risk_alerts: 'neg',
  compounders: 'pos',
};

export function ScannerPage() {
  const ep = useEndpoint<ScannerResponse>('/scanner', getScanner);

  if (ep.data === undefined) {
    return ep.error ? <ErrorState message={ep.error} onRetry={ep.reload} /> : <Loading label="Loading scanner…" />;
  }
  const categories = ep.data.categories ?? [];

  return (
    <div className="space-y-4">
      <p className="border-l-2 border-amber-soft/60 bg-ink-900/70 py-2 pl-3 text-xs text-mist">
        Scanner output is research surface only. <span className="text-amber-soft">Inclusion in a scanner category is
        not a trade</span> — orders exist only through the paper broker after a signal passes its risk checks.
      </p>

      {categories.length === 0 ? (
        <EmptyState title="No scanner categories">The scanner has not produced any categories yet.</EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {categories.map((c) => (
            <Card
              key={c.key}
              title={c.label}
              subtitle={c.note ?? 'Scanner inclusion is NOT a trade.'}
              actions={<Badge tone={CATEGORY_TONE[c.key] ?? 'neutral'}>{c.key}</Badge>}
            >
              {(c.items ?? []).length === 0 ? (
                <p className="text-xs text-mist">no candidates in this category</p>
              ) : (
                <ul className="space-y-1">
                  {(c.items ?? []).map((item) => (
                    <li
                      key={item.ticker}
                      className="flex items-center gap-3 border-b border-line/60 py-1.5 last:border-b-0"
                    >
                      <Link
                        to={`/tradingusa/stocks/${item.ticker}`}
                        className="w-16 shrink-0 font-mono text-sm font-semibold text-mint hover:underline"
                      >
                        {item.ticker}
                      </Link>
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-soft" title={item.company}>
                        {item.company}
                      </span>
                      <span className="w-20 shrink-0 text-right font-mono text-xs text-slate-soft">{money(item.price)}</span>
                      <span className={`w-16 shrink-0 text-right font-mono text-xs ${toneClass(item.changePct)}`}>
                        {pct(item.changePct)}
                      </span>
                      <span className="w-14 shrink-0 text-right font-mono text-xs text-mist">{number(item.score)}</span>
                      <span className="hidden min-w-0 flex-1 truncate text-[11px] text-mist sm:block" title={item.reason ?? ''}>
                        {item.reason ?? ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}