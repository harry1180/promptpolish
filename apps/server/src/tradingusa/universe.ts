/**
 * TradingUSA default stock universe + benchmarks.
 *
 * `tradable:false` marks context instruments (indexes / sector ETFs) used for
 * regime, relative strength and benchmarking — never traded by the paper
 * broker. Fully configurable later via tu_config.
 */

export interface UniverseEntry {
  ticker: string;
  company: string;
  sector: string;
  tradable: boolean;
}

export const BENCHMARKS = ['SPY', 'QQQ', 'DIA'] as const;
export const SECTOR_ETFS: Array<{ ticker: string; sector: string }> = [
  { ticker: 'XLK', sector: 'Technology' },
  { ticker: 'XLF', sector: 'Financials' },
  { ticker: 'XLE', sector: 'Energy' },
  { ticker: 'XLV', sector: 'Healthcare' },
  { ticker: 'XLI', sector: 'Industrials' },
  { ticker: 'XLP', sector: 'Consumer Staples' },
  { ticker: 'XLU', sector: 'Utilities' },
  { ticker: 'XLB', sector: 'Materials' },
  { ticker: 'XLC', sector: 'Communication' },
  { ticker: 'XLY', sector: 'Consumer Discretionary' },
  { ticker: 'XLRE', sector: 'Real Estate' },
];

const STOCKS: Array<[string, string, string]> = [
  ['AAPL', 'Apple Inc.', 'Technology'],
  ['MSFT', 'Microsoft Corporation', 'Technology'],
  ['NVDA', 'NVIDIA Corporation', 'Technology'],
  ['GOOGL', 'Alphabet Inc. Class A', 'Communication'],
  ['AMZN', 'Amazon.com Inc.', 'Consumer Discretionary'],
  ['META', 'Meta Platforms Inc.', 'Communication'],
  ['AVGO', 'Broadcom Inc.', 'Technology'],
  ['AMD', 'Advanced Micro Devices Inc.', 'Technology'],
  ['CRM', 'Salesforce Inc.', 'Technology'],
  ['ORCL', 'Oracle Corporation', 'Technology'],
  ['ADBE', 'Adobe Inc.', 'Technology'],
  ['NFLX', 'Netflix Inc.', 'Communication'],
  ['TSM', 'Taiwan Semiconductor ADR', 'Technology'],
  ['ASML', 'ASML Holding ADR', 'Technology'],
  ['MU', 'Micron Technology Inc.', 'Technology'],
  ['INTC', 'Intel Corporation', 'Technology'],
  ['QCOM', 'QUALCOMM Inc.', 'Technology'],
  ['JPM', 'JPMorgan Chase & Co.', 'Financials'],
  ['BAC', 'Bank of America Corp.', 'Financials'],
  ['GS', 'Goldman Sachs Group Inc.', 'Financials'],
  ['V', 'Visa Inc.', 'Financials'],
  ['MA', 'Mastercard Inc.', 'Financials'],
  ['UNH', 'UnitedHealth Group Inc.', 'Healthcare'],
  ['JNJ', 'Johnson & Johnson', 'Healthcare'],
  ['LLY', 'Eli Lilly & Company', 'Healthcare'],
  ['PFE', 'Pfizer Inc.', 'Healthcare'],
  ['MRK', 'Merck & Co. Inc.', 'Healthcare'],
  ['ABBV', 'AbbVie Inc.', 'Healthcare'],
  ['XOM', 'Exxon Mobil Corporation', 'Energy'],
  ['CVX', 'Chevron Corporation', 'Energy'],
  ['COP', 'ConocoPhillips', 'Energy'],
  ['WMT', 'Walmart Inc.', 'Consumer Staples'],
  ['COST', 'Costco Wholesale Corp.', 'Consumer Staples'],
  ['HD', 'The Home Depot Inc.', 'Consumer Discretionary'],
  ['NKE', 'NIKE Inc.', 'Consumer Discretionary'],
  ['MCD', "McDonald's Corporation", 'Consumer Discretionary'],
  ['SBUX', 'Starbucks Corporation', 'Consumer Discretionary'],
  ['KO', 'The Coca-Cola Company', 'Consumer Staples'],
  ['PEP', 'PepsiCo Inc.', 'Consumer Staples'],
  ['CAT', 'Caterpillar Inc.', 'Industrials'],
  ['BA', 'The Boeing Company', 'Industrials'],
  ['GE', 'GE Aerospace', 'Industrials'],
  ['UNP', 'Union Pacific Corporation', 'Industrials'],
  ['HON', 'Honeywell International Inc.', 'Industrials'],
  ['UPS', 'United Parcel Service Inc.', 'Industrials'],
  ['NEE', 'NextEra Energy Inc.', 'Utilities'],
  ['DIS', 'The Walt Disney Company', 'Communication'],
  ['T', 'AT&T Inc.', 'Communication'],
  ['VZ', 'Verizon Communications Inc.', 'Communication'],
  ['LIN', 'Linde plc', 'Materials'],
  ['PLD', 'Prologis Inc.', 'Real Estate'],
];

export const UNIVERSE: UniverseEntry[] = [
  ...STOCKS.map(([ticker, company, sector]) => ({ ticker, company, sector, tradable: true })),
  ...BENCHMARKS.map((ticker) => ({ ticker, company: `${ticker} index ETF`, sector: 'Index', tradable: false })),
  ...SECTOR_ETFS.map((e) => ({ ticker: e.ticker, company: `${e.ticker} sector ETF`, sector: e.sector, tradable: false })),
];

const byTicker = new Map(UNIVERSE.map((u) => [u.ticker, u]));

export function universeEntry(ticker: string): UniverseEntry | null {
  return byTicker.get(ticker) ?? null;
}

export function tradableUniverse(): UniverseEntry[] {
  return UNIVERSE.filter((u) => u.tradable);
}

export function contextUniverse(): UniverseEntry[] {
  return UNIVERSE.filter((u) => !u.tradable);
}

export const ALL_TICKERS: string[] = UNIVERSE.map((u) => u.ticker);
export const TRADABLE_TICKERS: string[] = tradableUniverse().map((u) => u.ticker);
