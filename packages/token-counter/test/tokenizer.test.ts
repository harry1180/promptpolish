import { describe, expect, it } from 'vitest';
import { estimateOutputTokens, estimateTokens, setExactTokenProvider, tokenizeWords } from '../src/index';

describe('token estimation', () => {
  it('counts a simple sentence above zero', () => {
    const t = estimateTokens('Hello, how are you?', 'heuristic');
    expect(t.tokens).toBeGreaterThan(3);
    expect(t.method).toBe('estimated');
  });

  it('roughly matches the ~4 chars/token rule for plain English', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    const t = estimateTokens(text, 'heuristic');
    // 43 chars -> expect within [8, 14]
    expect(t.tokens).toBeGreaterThanOrEqual(8);
    expect(t.tokens).toBeLessThanOrEqual(14);
  });

  it('monotonic in length', () => {
    const short = estimateTokens('short text here', 'heuristic').tokens;
    const long = estimateTokens('short text here and then a much longer body of additional words', 'heuristic').tokens;
    expect(long).toBeGreaterThan(short);
  });

  it('treats {{placeholders}} as single tokens in word tokenizer', () => {
    expect(tokenizeWords('Dear {{customer_name}}, hi')).toContain('{{customer_name}}');
    expect(tokenizeWords('id: {orderId} end')).toContain('{orderId}');
    expect(tokenizeWords('val ${total} x')).toContain('${total}');
  });

  it('uses registered exact provider when available', () => {
    setExactTokenProvider({ name: 'fake-exact', count: (t) => t.length });
    const r = estimateTokens('12345', 'heuristic');
    expect(r.method).toBe('exact');
    expect(r.tokens).toBe(5);
    setExactTokenProvider(null);
    expect(estimateTokens('12345', 'heuristic').method).toBe('estimated');
  });

  it('o200k approximation is labeled', () => {
    const r = estimateTokens('Analyze this prompt carefully.', 'o200k');
    expect(r.engine).toContain('o200k');
    expect(r.tokens).toBeGreaterThan(4);
  });
});

describe('output token projection', () => {
  it('classifies short-answer shapes as small outputs', () => {
    const r = estimateOutputTokens('Classify this ticket and label it: urgent or normal. Return one word only.');
    expect(r.shape).toBe('classification');
    expect(r.tokens).toBeLessThanOrEqual(80);
    expect(r.method).toBe('estimated');
  });

  it('JSON-shaped prompts project larger than classification prompts', () => {
    const json = estimateOutputTokens('Extract fields and return valid JSON schema output with customer_name, order_id and total for every row in the table below.');
    const cls = estimateOutputTokens('Classify and label it as positive or negative.');
    expect(json.tokens).toBeGreaterThan(cls.tokens);
    expect(json.shape).toBe('json-schema');
  });

  it('unknown shapes fall back to a general Q&A projection', () => {
    const r = estimateOutputTokens('Tell me something interesting about the ocean');
    expect(r.shape).toBe('qa');
    expect(r.tokens).toBeGreaterThanOrEqual(100);
    expect(r.engine).toContain('output projection');
  });

  it('is monotonic in prompt size for the same shape', () => {
    const a = estimateOutputTokens('Summarize this article: ' + 'lorem ipsum dolor sit amet '.repeat(50));
    const b = estimateOutputTokens('Summarize this article: ' + 'lorem ipsum dolor sit amet '.repeat(5));
    expect(a.tokens).toBeGreaterThan(b.tokens);
  });
});
