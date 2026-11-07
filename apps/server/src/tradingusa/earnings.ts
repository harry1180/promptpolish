/**
 * Next-earnings calendar for the entry guard.
 *
 * Source: Nasdaq public analyst endpoint (no key, verified reachable):
 *   GET https://api.nasdaq.com/api/analyst/{SYM}/earnings-date
 * Response carries both `reportText` ("…report earnings on 11/02/2026…")
 * and `announcement` ("…: Nov 02, 2026"); either shape is parsed, and only
 * a date ON OR AFTER today is accepted — a stale past date means the
 * calendar has not rolled to the next quarter yet, and we report unknown
 * (the guard then behaves exactly as before: no block).
 *
 * Failures are non-fatal by contract: a missing/unparseable date returns
 * null and the caller keeps the previous row (or none).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** First earnings date >= `today` (YYYY-MM-DD) found in the text, else null. */
export function parseEarningsDate(text: string, today: string): string | null {
  // "on 11/02/2026 after market close" — MM/DD/YYYY
  const slash = /(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
  if (slash) {
    const iso = `${slash[3]}-${slash[1]}-${slash[2]}`;
    if (iso >= today) return iso;
  }
  // "Earnings announcement* for AAPL: Nov 02, 2026"
  const named = /([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/.exec(text);
  if (named) {
    const m = MONTHS.indexOf(named[1]) + 1;
    if (m > 0) {
      const iso = `${named[3]}-${pad(m)}-${pad(Number(named[2]))}`;
      if (iso >= today) return iso;
    }
  }
  return null;
}

export interface EarningsFetchDeps {
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** Next earnings ISO date for a ticker, or null when unknown/unavailable. */
export async function fetchNextEarnings(
  ticker: string,
  today: string,
  deps: EarningsFetchDeps = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `https://api.nasdaq.com/api/analyst/${encodeURIComponent(ticker)}/earnings-date`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetchImpl(url, {
      headers: { 'user-agent': deps.userAgent ?? UA, accept: 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { reportText?: string; announcement?: string } | null;
    };
    const text = `${body.data?.reportText ?? ''} ${body.data?.announcement ?? ''}`;
    if (!text.trim()) return null;
    return parseEarningsDate(text, today);
  } catch {
    return null;
  }
}