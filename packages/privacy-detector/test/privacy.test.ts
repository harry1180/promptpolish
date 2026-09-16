import { describe, expect, it } from 'vitest';
import { detectSensitive, hasSensitive, redactSensitive } from '../src/index';

describe('sensitive data detection', () => {
  it('detects emails with masked sample', () => {
    const hits = detectSensitive('Contact jane.doe@example.com for details');
    const email = hits.find((h) => h.category === 'email');
    expect(email).toBeTruthy();
    expect(email!.samples[0]).toContain('***');
    expect(email!.samples[0]).not.toContain('doe@');
  });

  it('detects AWS keys', () => {
    expect(hasSensitive('key AKIAIOSFODNN7EXAMPLE here')).toBe(true);
  });

  it('detects OpenAI-style keys', () => {
    const hits = detectSensitive('use sk-proj-abcDEF1234567890wxyz now');
    expect(hits.some((h) => h.category === 'api-key')).toBe(true);
  });

  it('detects SSN pattern', () => {
    expect(hasSensitive('SSN 123-45-6789')).toBe(true);
    expect(hasSensitive('order 2026-09-15 date')).toBe(false);
  });

  it('detects phone numbers', () => {
    expect(hasSensitive('call (415) 555-2671 today')).toBe(true);
    expect(hasSensitive('value 1234567')).toBe(false);
  });

  it('detects IP addresses', () => {
    const hits = detectSensitive('server at 192.168.10.44 down');
    expect(hits.some((h) => h.category === 'ip-address')).toBe(true);
  });

  it('detects credit-card-like numbers', () => {
    expect(hasSensitive('card 4111 1111 1111 1111 exp 12/28')).toBe(true);
  });

  it('clean text has no hits', () => {
    expect(detectSensitive('Summarize the quarterly revenue report in 3 bullets')).toEqual([]);
  });

  it('redaction replaces values with markers', () => {
    const out = redactSensitive('mail john@corp.io and ip 10.0.0.1');
    expect(out).not.toContain('john@corp.io');
    expect(out).toContain('[REDACTED:email]');
    expect(out).toContain('[REDACTED:ip-address]');
  });
});
