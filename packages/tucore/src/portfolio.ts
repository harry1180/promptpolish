/**
 * Portfolio performance metrics — every field of PortfolioMetrics populated,
 * null only where the statistic is meaningless:
 * - <2 closed trades  -> winRate, profitFactor, expectancy, avgWinner, avgloser
 * - <10 equity points -> sharpe, sortino, volatility
 * - no downside bars   -> sortino
 * - <90 days of equity -> cagr
 * bestTrade/worstTrade are null only with zero closed trades.
 * `trades` counts every record passed in (open + closed); wins/losses/other
 * count closed trades only (other = net exactly 0). profitFactor with no
 * losing trades is Infinity (grossProfit/0); expectancy is the mean of closed
 * return fractions (equivalent to avgWinner*winRate + avgloser*lossRate).
 */
import type { EquityPoint, PortfolioMetrics, TradeRecord } from './types.ts';

function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function sampleStdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  let acc = 0;
  for (const v of values) {
    const d = v - mu;
    acc += d * d;
  }
  return Math.sqrt(acc / (values.length - 1));
}

/** Simple period returns from an equity curve (skips zero/undefined bases). */
export function dailyReturns(series: EquityPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].equity;
    if (!prev) continue;
    out.push(series[i].equity / prev - 1);
  }
  return out;
}

/** mean/std * sqrt(annualize). Null with <2 returns or zero dispersion. */
export function sharpe(returns: number[], annualize = 252): number | null {
  if (returns.length < 2) return null;
  const sd = sampleStdev(returns);
  if (sd === 0) return null; // no dispersion -> undefined
  return (mean(returns) / sd) * Math.sqrt(annualize);
}

/** mean/downsideDeviation * sqrt(annualize); null when there is no downside. */
export function sortino(returns: number[], annualize = 252): number | null {
  if (returns.length === 0) return null;
  let sumSq = 0;
  let hasDownside = false;
  for (const r of returns) {
    if (r < 0) {
      hasDownside = true;
      sumSq += r * r;
    }
  }
  if (!hasDownside) return null;
  const downside = Math.sqrt(sumSq / returns.length);
  if (downside === 0) return null;
  return (mean(returns) / downside) * Math.sqrt(annualize);
}

/** Worst drawdown of a series: min(v/peak - 1), always <= 0; null if <2 points. */
export function maxDrawdownFromSeries(series: number[]): number | null {
  if (series.length < 2) return null;
  let peak = series[0];
  let worst = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak !== 0) {
      const dd = v / peak - 1;
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

export interface MetricsInput {
  startingCapital: number;
  cash: number;
  currentEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  equitySeries: EquityPoint[];
  trades: TradeRecord[];
  benchmarkSeries: EquityPoint[];
  openNotional?: number;
}

const MS_PER_YEAR = 365.25 * 86400000;

export function computeMetrics(input: MetricsInput): PortfolioMetrics {
  const { startingCapital, cash, currentEquity, realizedPnl, unrealizedPnl, equitySeries, trades, benchmarkSeries } = input;

  const closed = trades.filter((t) => t.exitPrice !== null && t.exitTs !== null);
  const closedCount = closed.length;

  const tradeReturn = (t: TradeRecord): number => {
    const exit = t.exitPrice as number;
    if (!t.entryPrice) return 0;
    const diff = exit - t.entryPrice;
    return t.side === 'LONG' ? diff / t.entryPrice : -diff / t.entryPrice;
  };

  let wins = 0;
  let losses = 0;
  let other = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const rets: number[] = [];
  for (const t of closed) {
    const r = tradeReturn(t);
    rets.push(r);
    const pnl = t.side === 'LONG' ? (t.exitPrice as number - t.entryPrice) * t.qty : (t.entryPrice - (t.exitPrice as number)) * t.qty;
    if (r > 0) {
      wins++;
      grossProfit += pnl;
    } else if (r < 0) {
      losses++;
      grossLoss += -pnl;
    } else {
      other++;
    }
  }

  const totalReturn = startingCapital !== 0 ? currentEquity / startingCapital - 1 : 0;

  // CAGR from the equity curve's time span (null when <90 days)
  let cagr: number | null = null;
  if (equitySeries.length >= 2 && startingCapital > 0 && currentEquity > 0) {
    const span = equitySeries[equitySeries.length - 1].ts - equitySeries[0].ts;
    const days = span / 86400000;
    if (days >= 90) {
      const years = span / MS_PER_YEAR;
      cagr = Math.pow(currentEquity / startingCapital, 1 / years) - 1;
    }
  }

  const winRate = closedCount >= 2 ? wins / closedCount : null;
  const profitFactor = closedCount >= 2 ? (grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0) : null;
  const expectancy = closedCount >= 2 ? mean(rets) : null;
  const avgWinner = closedCount >= 2 && wins > 0 ? mean(rets.filter((r) => r > 0)) : null;
  const avgloser = closedCount >= 2 && losses > 0 ? mean(rets.filter((r) => r < 0)) : null;
  const bestTrade = closedCount > 0 ? Math.max(...rets) : null;
  const worstTrade = closedCount > 0 ? Math.min(...rets) : null;

  const returns = dailyReturns(equitySeries);
  const enoughPoints = equitySeries.length >= 10;
  const vol = enoughPoints ? sampleStdev(returns) : null;
  const sharpeVal = enoughPoints ? sharpe(returns) : null;
  const sortinoVal = enoughPoints ? sortino(returns) : null;
  const volatility = vol === null ? null : vol * Math.sqrt(252);

  const maxDrawdown = maxDrawdownFromSeries(equitySeries.map((p) => p.equity)) ?? 0;

  // Benchmark return over the same window as the equity curve
  let benchmarkReturn = 0;
  if (benchmarkSeries.length >= 2) {
    let bench = benchmarkSeries;
    if (equitySeries.length >= 2) {
      const t0 = equitySeries[0].ts;
      const t1 = equitySeries[equitySeries.length - 1].ts;
      const windowed = benchmarkSeries.filter((p) => p.ts >= t0 && p.ts <= t1);
      if (windowed.length >= 2) bench = windowed;
    }
    const first = bench[0].equity;
    if (first !== 0) benchmarkReturn = bench[bench.length - 1].equity / first - 1;
  }

  let closedNotional = 0;
  for (const t of closed) closedNotional += t.entryPrice * t.qty;
  const avgEquity = equitySeries.length > 0 ? mean(equitySeries.map((p) => p.equity)) : startingCapital;
  const turnover = avgEquity !== 0 ? closedNotional / avgEquity : 0;
  const exposure = currentEquity !== 0 ? (input.openNotional ?? 0) / currentEquity : 0;

  return {
    startingCapital,
    currentEquity,
    cash,
    realizedPnl,
    unrealizedPnl,
    totalReturn,
    cagr,
    winRate,
    profitFactor,
    expectancy,
    avgWinner,
    avgloser,
    sharpe: sharpeVal,
    sortino: sortinoVal,
    maxDrawdown,
    volatility,
    turnover,
    exposure,
    trades: trades.length,
    wins,
    losses,
    other,
    bestTrade,
    worstTrade,
    benchmarkReturn,
    excessReturn: totalReturn - benchmarkReturn,
  };
}