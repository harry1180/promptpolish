import { describe, expect, it } from 'vitest';
import { optimizePrompt } from '../src/index';
import { SAMPLE_PROMPTS } from '../src/samples';

const LEVELS = ['conservative', 'balanced', 'aggressive'] as const;

describe('optimizer core invariants', () => {
  it('output is never longer than input at any level', () => {
    for (const s of SAMPLE_PROMPTS) {
      for (const level of LEVELS) {
        const r = optimizePrompt(s.text, level);
        expect(r.optimizedTokens.tokens).toBeLessThanOrEqual(r.originalTokens.tokens);
      }
    }
  });

  it('empty input is handled', () => {
    const r = optimizePrompt('', 'balanced');
    expect(r.optimizedText).toBe('');
    expect(r.reductionPercent).toBe(0);
  });
});

describe('placeholder preservation (MUST never corrupt)', () => {
  const phText = `You are an assistant.
Please greet {{customer_name}} politely. Your total is \${total} and ref {orderId} with <customer_id> and [TENANT_ID].
Make sure that you include {{customer_name}} twice.`;

  for (const ph of ['{{customer_name}}', '${total}', '{orderId}', '<customer_id>', '[TENANT_ID]']) {
    it(`preserves ${ph} at every level`, () => {
      for (const level of LEVELS) {
        const r = optimizePrompt(phText, level);
        expect(r.optimizedText).toContain(ph);
      }
    });
  }

  it('preserves placeholder occurrence count', () => {
    for (const level of LEVELS) {
      const r = optimizePrompt(phText, level);
      const count = (r.optimizedText.match(/\{\{customer_name\}\}/g) ?? []).length;
      expect(count).toBe(2);
      expect(r.preservation.placeholders).toBe(100);
    }
  });
});

describe('JSON schema preservation', () => {
  const jsonPrompt = `You are an extraction engine. Please extract data.
Output format must be:
{"name": "string", "age": 0, "address": {"city": "string", "zip": "string"}}
Please always respond in valid JSON only. Thank you!`;

  for (const level of LEVELS) {
    it(`keeps JSON intact at ${level}`, () => {
      const r = optimizePrompt(jsonPrompt, level);
      const origJson = jsonPrompt.match(/\{[\s\S]*\}/)?.[0] ?? '';
      expect(r.optimizedText).toContain(origJson.replace(/\s+/g, ' ').trim());
      expect(r.optimizedText).toMatch(/"address"\s*:\s*\{/);
    });
  }

  it('preservation score confirms schema kept', () => {
    const r = optimizePrompt(jsonPrompt, 'aggressive');
    expect(r.preservation.notes.join(' ')).toContain('JSON schema preserved');
    expect(r.preservation.outputFormat).toBe(100);
  });
});

describe('XML tag preservation', () => {
  const xml = `Please answer using the context.
<context>
  <passage id="p1">Revenue grew 18% in Q3.</passage>
  <passage id="p2">Churn fell to 2.1%.</passage>
</context>
Please cite passage ids like [P1].`;
  for (const level of LEVELS) {
    it(`keeps XML blocks at ${level}`, () => {
      const r = optimizePrompt(xml, level);
      expect(r.optimizedText).toContain('<context>');
      expect(r.optimizedText).toContain('</context>');
      expect(r.optimizedText).toContain('<passage id="p1">');
      expect(r.optimizedText).toContain('Revenue grew 18% in Q3.');
    });
  }
});

describe('duplicate removal', () => {
  const dup = `Analyze the report.
The summary must be exactly 3 bullet points.
Always cite numbers from the source data.
The summary must be exactly 3 bullet points.
Always cite numbers from the source data.`;
  it('removes exact duplicate lines (conservative)', () => {
    const r = optimizePrompt(dup, 'conservative');
    const first = (r.optimizedText.match(/exactly 3 bullet points/g) ?? []).length;
    const second = (r.optimizedText.match(/cite numbers from the source data/g) ?? []).length;
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(r.changeLog.some((c) => c.kind === 'removed-duplicate')).toBe(true);
  });
});

describe('phrase compression', () => {
  it('compresses politeness and verbose collocations', () => {
    const r = optimizePrompt(
      'I would like you to please carefully analyze this. In order to do this, due to the fact that it is important, keep it short. Thanks!',
      'balanced',
    );
    const out = r.optimizedText.toLowerCase();
    expect(out).not.toContain('i would like you to');
    expect(out).not.toContain('in order to');
    expect(out).not.toContain('due to the fact that');
    expect(r.reductionPercent).toBeGreaterThan(10);
  });

  it('conservative keeps imperative verb meaning', () => {
    const r = optimizePrompt('Please make sure that you review the contract.', 'conservative');
    expect(r.optimizedText.toLowerCase()).toMatch(/review the contract/);
    expect(r.optimizedText.toLowerCase()).not.toMatch(/please make sure that you/);
  });
});

describe('semantic safety: constraint lines survive aggressive mode', () => {
  it('keeps MUST/NEVER constraints', () => {
    const text = `You are a legal assistant. Please draft a summary. It is important to note that accuracy matters.
MUST include the statute number.
NEVER provide legal advice.
Respond in exactly 2 paragraphs.`;
    for (const level of LEVELS) {
      const r = optimizePrompt(text, level);
      expect(r.optimizedText).toMatch(/MUST include the statute number/i);
      expect(r.optimizedText).toMatch(/NEVER provide legal advice/i);
      expect(r.optimizedText).toMatch(/exactly 2 paragraphs/i);
    }
  });
});

describe('sample prompts achieve meaningful reduction', () => {
  for (const s of SAMPLE_PROMPTS) {
    it(`${s.id}: balanced reduces >= 2%`, () => {
      const r = optimizePrompt(s.text, 'balanced');
      expect(r.reductionPercent).toBeGreaterThanOrEqual(2); // json-complex is schema-dominated (protected)
    });
    it(`${s.id}: aggressive >= balanced`, () => {
      const b = optimizePrompt(s.text, 'balanced');
      const a = optimizePrompt(s.text, 'aggressive');
      expect(a.reductionPercent).toBeGreaterThanOrEqual(b.reductionPercent - 0.001);
    });
  }
  it('redundant samples (support) reduce >= 20% balanced', () => {
    const r = optimizePrompt(SAMPLE_PROMPTS[0]!.text, 'balanced');
    expect(r.reductionPercent).toBeGreaterThanOrEqual(20);
  });
});

describe('preservation score shape', () => {
  it('returns 0-100 sub-scores with warnings/notes', () => {
    const r = optimizePrompt(SAMPLE_PROMPTS[0]!.text, 'balanced');
    for (const v of [r.preservation.intent, r.preservation.constraints, r.preservation.outputFormat, r.preservation.placeholders, r.preservation.overall]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(Array.isArray(r.preservation.warnings)).toBe(true);
    expect(Array.isArray(r.preservation.notes)).toBe(true);
  });
});
