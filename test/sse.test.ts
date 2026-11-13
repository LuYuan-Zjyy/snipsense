import { describe, expect, it } from 'vitest';
import { createSseParser, extractApiError, extractDelta } from '../src/core/sse';

describe('createSseParser', () => {
  it('dispatches events split across chunks', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: {"a":');
    parser.push('1}\n\ndata: {"b":2}\n\n');
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('joins multiple data lines', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: first\ndata: second\n\n');
    expect(events).toEqual(['first\nsecond']);
  });

  it('handles CRLF and a final event without a blank line', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: one\r\n\r\n');
    parser.push('data: two');
    parser.end();
    expect(events).toEqual(['one', 'two']);
  });

  it('ignores comments', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push(': keep-alive\n\n');
    expect(events).toEqual([]);
  });
});

describe('OpenAI payload helpers', () => {
  it('extracts string delta content', () => {
    expect(extractDelta({ choices: [{ delta: { content: 'hello' } }] })).toBe('hello');
  });

  it('extracts array content', () => {
    expect(
      extractDelta({ choices: [{ delta: { content: [{ type: 'text', text: 'hello' }] } }] }),
    ).toBe('hello');
  });

  it('extracts a non-streaming message', () => {
    expect(extractDelta({ choices: [{ message: { content: 'OK' } }] })).toBe('OK');
  });

  it('extracts API errors', () => {
    expect(extractApiError({ error: { message: 'invalid key' } })).toBe('invalid key');
    expect(extractApiError({ error: 'bad gateway' })).toBe('bad gateway');
  });
});
