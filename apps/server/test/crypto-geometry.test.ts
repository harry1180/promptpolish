/**
 * Approved exit geometry C (horizon-matched sigma_H) + the CRYPTO_TARGET_MODE
 * switch that selects it. The formula must stay byte-identical to the `C` row
 * of scripts/alpha-research.mts — that is the row the walk-forward selected
 * and the user approved for live use.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sigmahGeometry } from '../src/crypto/engine.ts';
import { cryptoConfigFromEnv } from '../src/crypto/config.ts';

test('sigmahGeometry: stop 1.0*sigma_H below, target 2.0*sigma_H above', () => {
  // price 100, ATR 4, hold 5 sessions -> sigma_H = 0.04 * sqrt(5)
  const g = sigmahGeometry(100, 4, 5);
  assert.ok(g, 'geometry must be produced for valid inputs');
  const sigmaH = 0.04 * Math.sqrt(5);
  assert.ok(Math.abs((g?.stopPct ?? 0) - sigmaH * 100) < 1e-9);
  assert.ok(Math.abs((g?.stop ?? 0) - 100 * (1 - sigmaH)) < 1e-9);
  assert.ok(Math.abs((g?.target ?? 0) - 100 * (1 + 2 * sigmaH)) < 1e-9);
  assert.equal(g?.rr, 2, 'risk:reward is fixed at 2:1 by construction');
  // the whole point: the stop is no longer inside daily noise
  assert.ok((g?.stopPct ?? 0) > 5, `stop must clear the 0.5% floor by miles: ${g?.stopPct}`);
});

test('sigmahGeometry: wider stop than the old ~0.5%-1% class that stopped every trade', () => {
  const g = sigmahGeometry(75_000, 2_000, 5); // BTC-ish: 2.67% daily ATR
  assert.ok(g);
  const expectedPct = (2_000 / 75_000) * Math.sqrt(5) * 100; // 5.96%
  assert.ok(Math.abs((g?.stopPct ?? 0) - expectedPct) < 1e-9, `stop ${g?.stopPct} vs ${expectedPct}`);
  assert.ok((g?.stopPct ?? 0) > 5, `stop distance must clear daily noise: ${g?.stopPct}`);
  assert.ok((g?.targetPct ?? 0) > 11);
});

test('sigmahGeometry: refuses to invent numbers from unusable inputs', () => {
  assert.equal(sigmahGeometry(0, 4, 5), null, 'no price -> null');
  assert.equal(sigmahGeometry(100, 0, 5), null, 'no ATR -> null');
  assert.equal(sigmahGeometry(-1, 4, 5), null, 'negative price -> null');
  assert.equal(sigmahGeometry(100, -4, 5), null, 'negative ATR -> null');
});

test('sigmahGeometry: missing/zero hold falls back to 5 sessions, never to a coin flip', () => {
  const base = sigmahGeometry(100, 4, 5);
  const a = sigmahGeometry(100, 4, undefined);
  const b = sigmahGeometry(100, 4, 0);
  const c = sigmahGeometry(100, 4, null);
  assert.equal(a?.stop, base?.stop);
  assert.equal(b?.stop, base?.stop);
  assert.equal(c?.stop, base?.stop);
  // longer expected hold -> wider bands (monotone in H)
  const long = sigmahGeometry(100, 4, 20);
  assert.ok((long?.stopPct ?? 0) > (base?.stopPct ?? 0));
});

test('CRYPTO_TARGET_MODE=sigmah selects geometry C; anything else never silently becomes C', () => {
  assert.equal(cryptoConfigFromEnv({ CRYPTO_TARGET_MODE: 'sigmah' }).targetMode, 'sigmah');
  assert.equal(cryptoConfigFromEnv({ CRYPTO_TARGET_MODE: 'atr3' }).targetMode, 'atr3');
  assert.equal(cryptoConfigFromEnv({}).targetMode, 'sr');
  assert.equal(cryptoConfigFromEnv({ CRYPTO_TARGET_MODE: 'SIGMAH' }).targetMode, 'sr', 'case-sensitive: no fuzzy match');
  assert.equal(cryptoConfigFromEnv({ CRYPTO_TARGET_MODE: 'typo' }).targetMode, 'sr', 'unknown value falls back to sr');
});