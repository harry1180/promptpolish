/**
 * Macro data: U.S. Treasury daily yield curve (official CSV, no key) and
 * VIX via the market-data provider.
 */
import type { ProviderStatus } from '@promptslim/tucore';

export interface YieldRow {
  date: string; // YYYY-MM-DD
  y2: number | null;
  y5: number | null;
  y10: number | null;
  y30: number | null;
}

export class MacroProvider {
  readonly name = 'us-treasury';
  private fetchImpl: typeof fetch;
  private _status: ProviderStatus = 'UNAVAILABLE';
  private _lastError: string | null = null;

  constructor(deps: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  status(): ProviderStatus { return this._status; }
  lastError(): string | null { return this._lastError; }

  async treasuryYields(year = new Date().getFullYear(), limit = 30): Promise<YieldRow[]> {
    const url =
      `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all` +
      `?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'user-agent': 'Mozilla/5.0 TradingUSA research' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`treasury HTTP ${res.status}`);
      const csv = await res.text();
      this._status = 'CONNECTED';
      this._lastError = null;
      return parseTreasuryCsv(csv, limit);
    } catch (err) {
      this._status = 'DEGRADED';
      this._lastError = err instanceof Error ? err.message : 'treasury error';
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseTreasuryCsv(csv: string, limit: number): YieldRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
  const col = (name: string): number => header.indexOf(name);
  const idx = { date: col('Date'), y2: col('2 Yr'), y5: col('5 Yr'), y10: col('10 Yr'), y30: col('30 Yr') };
  const num = (s: string | undefined): number | null => {
    if (s == null) return null;
    const v = Number(s.replace(/"/g, '').trim());
    return Number.isFinite(v) ? v : null;
  };
  const out: YieldRow[] = [];
  for (let i = 1; i < lines.length && out.length < limit; i++) {
    const cells = lines[i].split(',');
    const rawDate = cells[idx.date]?.replace(/"/g, '').trim();
    if (!rawDate) continue;
    const [mm, dd, yyyy] = rawDate.split('/');
    const date = yyyy && mm && dd ? `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` : rawDate;
    out.push({ date, y2: num(cells[idx.y2]), y5: num(cells[idx.y5]), y10: num(cells[idx.y10]), y30: num(cells[idx.y30]) });
  }
  return out;
}
