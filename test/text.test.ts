import { describe, expect, it } from 'vitest';
import {
  firstSentence,
  normalizeNewlines,
  stripMarkdown,
  truncate,
  truncateMiddle,
} from '../src/core/text';

describe('text helpers', () => {
  it('normalizes Windows newlines', () => {
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('truncates a long middle while preserving both ends', () => {
    const source = 'A'.repeat(80) + 'MIDDLE' + 'B'.repeat(80);
    const result = truncateMiddle(source, 80);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('A')).toBe(true);
    expect(result.text.endsWith('B')).toBe(true);
    expect(result.text).toContain('中间部分已省略');
    expect(result.text.length).toBeLessThanOrEqual(80);
  });

  it('does not mark short text as truncated', () => {
    expect(truncateMiddle('short', 20)).toEqual({ text: 'short', truncated: false });
  });

  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
  });

  it('strips simple markdown', () => {
    expect(stripMarkdown('**重点**：使用 `useState`。')).toBe('重点：使用 useState。');
  });

  it('extracts the first sentence', () => {
    expect(firstSentence('这是第一句。这是第二句。')).toBe('这是第一句');
    expect(firstSentence('No punctuation here')).toBe('No punctuation here');
  });
});
