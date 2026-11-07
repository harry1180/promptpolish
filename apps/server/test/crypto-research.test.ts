/**
 * Pins the research math used by scripts/fixed-horizon-study.mts and
 * scripts/alpha-research.mts: Wilson intervals, directional stats,
 * conservative first-passage, hit probabilities, EV gate, break-even.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  directionalStats, evGate, firstPassage, hitProbabilities,
  horizonEconomics, wilson,
} from '../src/crypto/research.ts';

test('wilson: known interval, n=0 stays null', () => {
  const w = wilson(7, 9);
  assert.equal(w.pct, 7 / 9);
  assert.ok(w.lo !== null && w.hi !== null && w.lo < w.pct! && w.hi > w.pct!);
  assert.ok(w.hi! - w.lo! > 0.3, 'n=9 must stay wide — no fake precision');
  const w2 = wilson(536, 1000);
  assert.ok(w2.lo! > 0.5 && w2.hi! < 0.575, 'large n tightens around 0.536');
  const empty = wilson(0, 0);
  assert.equal(empty.pct, null);
  assert.equal(empty.lo, null);
});

test('directionalStats: class balance, flat exclusion, baselines sum to 1', () => {
  const s = directionalStats([
    { predicted: 'UP', actual: 'UP' },
    { predicted: 'UP', actual: 'DOWN' },
    { predicted: 'DOWN', actual: 'DOWN' },
    { predicted: 'UP', actual: 'FLAT' },
  ]);
  assert.equal(s.evaluated, 4);
  assert.equal(s.flat, 1);
  assert.equal(s.correct, 2);
  assert.equal(s.up, 1);
  assert.equal(s.down, 2);
  assert.ok(Math.abs((s.alwaysUp ?? 0) + (s.alwaysDown ?? 0) - 1) < 1e-12);
  assert.equal(s.alwaysUp, 1 / 3, 'always-up baseline = class share, not accuracy');
  assert.equal(s.accuracy.n, 3, 'FLAT outcomes never enter the accuracy denominator');
});

test('firstPassage: stop wins a same-bar touch (conservative, like checkExit)', () => {
  const bars = [
    { high: 105, low: 99 },   // touches both: stop 99.5, target 104
    { high: 110, low: 104.5 },
  ];
  assert.equal(firstPassage(bars, 99.5, 104, 10), 'STOP_FIRST');
  assert.equal(
    firstPassage([{ high: 103, low: 101 }, { high: 106, low: 102 }], 99, 105, 10),
    'TARGET_FIRST',
  );
  assert.equal(firstPassage([{ high: 103, low: 101 }], 95, 110, 10), 'CENSORED');
  assert.equal(firstPassage([{ high: 110, low: 90 }], 99, 101, 1), 'STOP_FIRST');
  assert.equal(firstPassage([], 99, 101, 5), 'CENSORED');
  // maxBars bounds the window: later stop hit beyond the cap is ignored
  assert.equal(
    firstPassage([{ high: 103, low: 101 }, { high: 103, low: 90 }], 95, 110, 1),
    'CENSORED',
  );
});

test('hitProbabilities: frequencies over an episode sample', () => {
  const p = hitProbabilities(['STOP_FIRST', 'TARGET_FIRST', 'CENSORED', 'STOP_FIRST', 'AMBIGUOUS']);
  assert.equal(p.n, 5);
  assert.equal(p.pStop, 3 / 5, 'AMBIGUOUS counts as stop-family (both touched)');
  assert.equal(p.pTarget, 1 / 5);
  assert.equal(p.pCensored, 1 / 5);
  const none = hitProbabilities([]);
  assert.equal(none.pCensored, 1);
});

test('evGate: positive only when priced edge beats costs', () => {
  // pT=0.3, rr=3 -> 0.9; minus pS=0.5 -> 0.4; costs 0.5R -> -0.1 (reject)
  assert.ok(evGate({ pTarget: 0.3, pStop: 0.5, rr: 3, costOverRisk: 0.5 }) < 0);
  assert.ok(evGate({ pTarget: 0.3, pStop: 0.5, rr: 3, costOverRisk: 0.2 }) > 0);
  assert.equal(evGate({ pTarget: 0, pStop: 1, rr: 10, costOverRisk: 0 }), -1);
});

test('horizonEconomics: real fee tiers set the break-even bar', () => {
  const cheap = horizonEconomics('30s', 0.0016, 0.0005); // configured 0.16% + 5bps slip
  assert.ok(Math.abs(cheap.costRtPct - 0.42) < 1e-9, '0.16%*2 + 5bps*2 = 0.42% RT');
  const tier1 = horizonEconomics('30s', 0.008, 0.0005); // Kraken tier-1 taker 0.80%
  assert.ok(Math.abs(tier1.costRtPct - 1.7) < 1e-9, '0.80%*2 + 5bps*2 = 1.70% RT');
  assert.ok(tier1.requiredMovePct > cheap.requiredMovePct * 3);
});
