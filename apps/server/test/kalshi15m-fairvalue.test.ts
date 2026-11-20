/**
 * Settlement fair value: the variance derivation, the two published sanity
 * checks it must reproduce, and the refusal to emit a number without inputs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fairValue, impliedSigma, modelEdge, normCdf, normInv, settlementVariance, tauSeconds,
} from '../src/kalshi15m/fairvalue.ts';

test('settlement variance: tau>=60 collapses to v*(tau-40), verified against the tape study', () => {
  const v150 = settlementVariance(150, 0.0001);
  assert.ok(v150);
  assert.equal(v150.varianceUnits, 110, '150-40 = 110 units');
  // published: with 150s (12:30 of a 15-min window) left, uncertainty is
  // 14% smaller than a last-tick settle
  assert.ok(Math.abs(v150.vsLastTick - Math.sqrt(110 / 150)) < 1e-12);
  assert.ok(Math.abs(v150.vsLastTick - 0.8571) < 0.001, `14.3% smaller, got ${v150.vsLastTick}`);
  assert.equal(v150.regime, 'WINDOW_OPEN');

  const v780 = settlementVariance(780, 0.0001);
  assert.equal(v780?.varianceUnits, 740);
  assert.equal(v780?.regime, 'WINDOW_OPEN');
});

test('settlement variance: inside the final minute it is v*tau^3/10800 (tau^1.5 scaling)', () => {
  const v30 = settlementVariance(30, 0.0001);
  assert.ok(v30);
  assert.equal(v30.varianceUnits, 30 ** 3 / 10_800, '27000/10800 = 2.5');
  // published: with 30 seconds left, uncertainty is 71% smaller than last-tick
  assert.ok(Math.abs(v30.vsLastTick - 30 / Math.sqrt(10_800)) < 1e-12);
  assert.ok(Math.abs(v30.vsLastTick - 0.2887) < 0.001, `71.1% smaller, got ${v30.vsLastTick}`);
  assert.equal(v30.regime, 'SETTLEMENT_MINUTE');

  // std scales as tau^1.5 inside the minute (the claim under test)
  const a = settlementVariance(10, 1)!;
  const b = settlementVariance(40, 1)!;
  assert.ok(Math.abs(b.stdUnits / a.stdUnits - (40 / 10) ** 1.5) < 1e-9);
});

test('settlement variance: continuous at tau=60 from both regimes', () => {
  const below = settlementVariance(60 - 1e-9, 1)!;
  const at = settlementVariance(60, 1)!;
  const above = settlementVariance(60 + 1e-9, 1)!;
  assert.ok(Math.abs(at.varianceUnits - 20) < 1e-6, 'exactly 20 units at 60s');
  assert.ok(Math.abs(below.varianceUnits - at.varianceUnits) < 1e-6);
  assert.ok(Math.abs(above.varianceUnits - at.varianceUnits) < 1e-6);
});

test('settlement variance: refuses impossible inputs', () => {
  assert.equal(settlementVariance(0, 0.0001), null, 'window closed');
  assert.equal(settlementVariance(-5, 0.0001), null);
  assert.equal(settlementVariance(100, 0), null, 'zero volatility is not a model');
  assert.equal(settlementVariance(100, -1), null);
  assert.equal(settlementVariance(NaN, 0.0001), null);
});

test('normCdf: standard values', () => {
  // rational approximation: ~1e-7 accurate, never claimed better
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-3);
  assert.ok(Math.abs(normCdf(3) - 0.99865) < 1e-4);
    assert.ok(normCdf(-10) < 1e-20, 'far left tail is effectively zero');
  assert.ok(normCdf(10) >= 1 - 1e-15, 'far right tail saturates at 1 in float');
});

test('fairValue: at the money is exactly a coin flip', () => {
  const fv = fairValue({ spot: 59_000, strike: 59_000, tauSec: 300, sigmaPerSec: 0.0001, approx: 'kraken' });
  assert.ok(fv.pYes !== null);
  assert.ok(Math.abs((fv.pYes ?? 1) - 0.5) < 1e-6, `at-the-money p=${fv.pYes}`);
  assert.equal(fv.pNo, 1 - fv.pYes);
  assert.ok(Math.abs(fv.z ?? 99) < 1e-12);
  assert.equal(fv.reference, 'APPROXIMATION', 'spot is never the official reference');
  assert.equal(fv.approx, 'kraken');
  assert.equal(fv.regime, 'WINDOW_OPEN');
});

test('fairValue: direction, magnitude and time decay behave like a binary', () => {
  const mk = (spot: number, tau: number) =>
    fairValue({ spot, strike: 59_000, tauSec: tau, sigmaPerSec: 0.0002, approx: 'coinbase' });
  const above = mk(59_200, 300);
  const below = mk(58_800, 300);
  assert.ok((above.pYes ?? 0) > 0.5, 'above strike -> YES more likely than not');
  assert.ok((below.pYes ?? 0) < 0.5, 'below strike -> YES less likely than not');
  // multiplicative symmetry: equal log-distance either side must sum to 1
  const up = fairValue({ spot: 59_000 * Math.exp(0.004), strike: 59_000, tauSec: 300, sigmaPerSec: 0.0002 });
  const down = fairValue({ spot: 59_000 * Math.exp(-0.004), strike: 59_000, tauSec: 300, sigmaPerSec: 0.0002 });
  assert.ok(Math.abs((up.pYes ?? 0) + (down.pYes ?? 0) - 1) < 1e-6, 'log-symmetric pair sums to 1');

  // more time left at the same distance = less certainty about the sign
  const far = mk(59_200, 900);
  const near = mk(59_200, 30);
  assert.ok((far.pYes ?? 0) < (above.pYes ?? 0), 'longer horizon -> less certainty');
  assert.ok((near.pYes ?? 0) > 0.99, 'a decisive distance with 30s left is near-certain');
  assert.equal(near.regime, 'SETTLEMENT_MINUTE');

  // as tau -> 0, a decisive distance collapses to certainty (sigma 0.0002/s
  // over 2s = $0.32 of uncertainty on a $59k book, so ±$5 is decisive)
  const last = mk(59_005, 2);
  const lastDown = mk(58_995, 2);
  assert.ok((last.pYes ?? 0) > 0.999, `last p=${last.pYes}`);
  assert.ok((lastDown.pYes ?? 0) < 0.001, `lastDown p=${lastDown.pYes}`);
  // ...while one cent away at the same horizon is still a coin flip:
  const centAway = mk(59_000.01, 2);
  assert.ok(Math.abs((centAway.pYes ?? 0) - 0.5) < 0.05, `cent p=${centAway.pYes}`);
});

test('fairValue: sigma moves the probability both ways as expected', () => {
  const calm = fairValue({ spot: 59_100, strike: 59_000, tauSec: 300, sigmaPerSec: 0.00005 });
  const wild = fairValue({ spot: 59_100, strike: 59_000, tauSec: 300, sigmaPerSec: 0.001 });
  assert.ok((calm.pYes ?? 0) > (wild.pYes ?? 0), 'more volatility pulls an out-of-the-money YES back to 0.5');
  assert.ok((wild.pYes ?? 0) > 0.4 && (wild.pYes ?? 0) < 0.6, 'huge sigma ~ coin flip');
});

test('fairValue: missing inputs produce null + a reason, never a plausible guess', () => {
  const noSpot = fairValue({ spot: null, strike: 59_000, tauSec: 300, sigmaPerSec: 0.0001 });
  assert.equal(noSpot.pYes, null);
  assert.equal(noSpot.reason, 'no_spot');
  assert.equal(noSpot.reference, 'APPROXIMATION');

  assert.equal(fairValue({ spot: 59_000, strike: null, tauSec: 300, sigmaPerSec: 0.0001 }).reason, 'no_strike');
  assert.equal(fairValue({ spot: 59_000, strike: 59_000, tauSec: null, sigmaPerSec: 0.0001 }).reason, 'no_tau');
  assert.equal(fairValue({ spot: 59_000, strike: 59_000, tauSec: 0, sigmaPerSec: 0.0001 }).reason, 'window_closed');
  assert.equal(fairValue({ spot: 59_000, strike: 59_000, tauSec: 300, sigmaPerSec: null }).reason, 'no_sigma');
  assert.equal(fairValue({ spot: 59_000, strike: 59_000, tauSec: 300, sigmaPerSec: 0 }).reason, 'no_sigma');
});

test('impliedSigma inverts the model — the calibration instrument', () => {
  const sigma = 0.0004;
  const tau = 600;
  const spot = 59_150;
  const strike = 59_000;
  const fv = fairValue({ spot, strike, tauSec: tau, sigmaPerSec: sigma });
  assert.ok(fv.pYes !== null && fv.pYes > 0.5);
  const back = impliedSigma(fv.pYes, spot, strike, tau);
  assert.ok(back !== null, 'a decisive-but-not-saturated p inverts cleanly');
  assert.ok(Math.abs(back / sigma - 1) < 1e-4, `round trip ${back} vs ${sigma}`);
});

test('impliedSigma refuses inversions that carry no information', () => {
  assert.equal(impliedSigma(0.5, 59_000, 59_000, 300), null, 'at the money: every sigma fits');
  assert.equal(impliedSigma(0.49, 59_000, 59_000, 300), null, 'z below the floor');
  assert.equal(impliedSigma(0.2, 59_100, 59_000, 300), null,
    'sign mismatch: book prices DOWN while spot is ABOVE strike — a data problem, not a vol');
  assert.equal(impliedSigma(null, 59_100, 59_000, 300), null);
  assert.equal(impliedSigma(0.9, null, 59_000, 300), null);
  assert.equal(impliedSigma(0.9, 59_100, 59_000, 0), null, 'window closed');
  assert.equal(impliedSigma(0.9, 59_100, 59_000, null), null);
});

test('normInv round-trips normCdf', () => {
  for (const p of [0.025, 0.1, 0.3, 0.5, 0.7, 0.9, 0.975]) {
    const x = normInv(p);
    assert.ok(x !== null, `p=${p}`);
    assert.ok(Math.abs(normCdf(x) - p) < 1e-6, `p=${p} -> ${x} -> ${normCdf(x)}`);
  }
  assert.equal(normInv(0), null, 'open interval only');
  assert.equal(normInv(1), null);
  assert.equal(normInv(-0.1), null);
});

test('modelEdge and tauSeconds', () => {
  assert.ok(Math.abs((modelEdge(0.6, 0.5) ?? 0) - 0.1) < 1e-9, 'model says 60c, book asks 50c');
  assert.equal(modelEdge(null, 0.5), null, 'no model -> no edge claimed');
  assert.equal(modelEdge(0.6, null), null, 'no book -> no edge claimed');
  assert.equal(tauSeconds(Date.parse('2026-11-20T20:15:00Z'), Date.parse('2026-11-20T20:14:00Z')), 60);
  assert.equal(tauSeconds(Date.parse('2026-11-20T20:14:00Z'), Date.parse('2026-11-20T20:15:00Z')), -60);
});