import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, computeBudget } from '../src/budget.ts';
import type { BudgetInput } from '../src/budget.ts';
import type { SessionKind } from '../src/types.ts';

function input(session: SessionKind, overrides: Partial<BudgetInput> = {}): BudgetInput {
  return {
    session,
    portfolioExposure: 0.5,
    openCandidates: 3,
    dataFreshness: 0.9,
    providerHealthy: true,
    systemLoad: 0.3,
    ...overrides,
  };
}

describe('DEFAULT_LIMITS', () => {
  it('matches the contract', () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxRoutineLlmCallsPerDay: 30,
      maxHighPriorityLlmCallsPerDay: 15,
      llmReservePercent: 25,
      groqTokensPerDay: 120000,
      geminiTokensPerDay: 200000,
    });
  });
});

describe('computeBudget', () => {
  it('MARKET_OPEN cadence and flags', () => {
    const b = computeBudget(input('MARKET_OPEN'));
    expect(b).toEqual({
      quotePollMs: 20000,
      featureIntervalMs: 60000,
      crawlIntervalMs: 300000,
      mlIntervalMs: 60000,
      llmAllowed: true,
      maxRoutineLlmCalls: 30,
      intradayEnabled: true,
      markToMarketEnabled: true,
    });
  });

  it('MARKET_OPEN slows quote polling under load or stale data', () => {
    expect(computeBudget(input('MARKET_OPEN', { systemLoad: 0.9 })).quotePollMs).toBe(60000);
    expect(computeBudget(input('MARKET_OPEN', { dataFreshness: 0.4 })).quotePollMs).toBe(60000);
    expect(computeBudget(input('MARKET_OPEN', { systemLoad: 0.8 })).quotePollMs).toBe(20000); // strict >
    expect(computeBudget(input('MARKET_OPEN', { dataFreshness: 0.5 })).quotePollMs).toBe(20000);
  });

  it('EARLY_CLOSE keeps intraday flags with a 180s crawl', () => {
    const b = computeBudget(input('EARLY_CLOSE'));
    expect(b.quotePollMs).toBe(20000);
    expect(b.featureIntervalMs).toBe(60000);
    expect(b.crawlIntervalMs).toBe(180000);
    expect(b.intradayEnabled).toBe(true);
    expect(b.markToMarketEnabled).toBe(true);
    expect(b.maxRoutineLlmCalls).toBe(30);
  });

  it('PREMARKET / POSTMARKET cadence', () => {
    const pre = computeBudget(input('PREMARKET'));
    expect(pre).toMatchObject({
      quotePollMs: 120000,
      featureIntervalMs: 300000,
      crawlIntervalMs: 120000,
      intradayEnabled: false,
      markToMarketEnabled: false,
      llmAllowed: true,
      maxRoutineLlmCalls: 10,
    });
    const post = computeBudget(input('POSTMARKET'));
    expect(post).toMatchObject({
      quotePollMs: 300000,
      featureIntervalMs: 600000,
      crawlIntervalMs: 600000,
      intradayEnabled: false,
      markToMarketEnabled: false,
      maxRoutineLlmCalls: 10,
    });
  });

  it('MARKET_CLOSED cadence', () => {
    expect(computeBudget(input('MARKET_CLOSED'))).toMatchObject({
      quotePollMs: 900000,
      featureIntervalMs: 3600000,
      crawlIntervalMs: 1800000,
      intradayEnabled: false,
      markToMarketEnabled: false,
      llmAllowed: true,
      maxRoutineLlmCalls: 0,
    });
  });

  it('WEEKEND and HOLIDAY cadence', () => {
    for (const session of ['WEEKEND', 'HOLIDAY'] as const) {
      expect(computeBudget(input(session))).toMatchObject({
        quotePollMs: 3600000,
        featureIntervalMs: 7200000,
        crawlIntervalMs: 3600000,
        intradayEnabled: false,
        markToMarketEnabled: false,
        llmAllowed: true,
        maxRoutineLlmCalls: 0,
      });
    }
  });

  it('providerHealthy=false doubles quotePollMs', () => {
    expect(computeBudget(input('MARKET_OPEN', { providerHealthy: false })).quotePollMs).toBe(40000);
    expect(computeBudget(input('MARKET_CLOSED', { providerHealthy: false })).quotePollMs).toBe(1800000);
  });

  it('field overrides win last', () => {
    const b = computeBudget(input('MARKET_OPEN', {
      providerHealthy: false,
      overrides: { quotePollMs: 1234, maxRoutineLlmCalls: 7, intradayEnabled: false, llmAllowed: false },
    }));
    expect(b.quotePollMs).toBe(1234); // beats both the table and the unhealthy doubling
    expect(b.maxRoutineLlmCalls).toBe(7);
    expect(b.intradayEnabled).toBe(false);
    expect(b.llmAllowed).toBe(false);
    // untouched fields keep their table values
    expect(b.featureIntervalMs).toBe(60000);
    expect(b.crawlIntervalMs).toBe(300000);
  });

  it('limit overrides re-cap maxRoutineLlmCalls', () => {
    const capped = computeBudget(input('MARKET_OPEN', { overrides: { maxRoutineLlmCallsPerDay: 5 } }));
    expect(capped.maxRoutineLlmCalls).toBe(5);
    // can never exceed the session table (0 outside hours)
    const weekend = computeBudget(input('WEEKEND', { overrides: { maxRoutineLlmCallsPerDay: 5 } }));
    expect(weekend.maxRoutineLlmCalls).toBe(0);
    const raised = computeBudget(input('PREMARKET', { overrides: { maxRoutineLlmCallsPerDay: 100 } }));
    expect(raised.maxRoutineLlmCalls).toBe(10); // session cap of 10 still applies
  });
});