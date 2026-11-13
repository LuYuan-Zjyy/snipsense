import { describe, expect, it } from 'vitest';
import { buildContextWindow, isUsefulSelection } from '../src/core/selection';

const documentText = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n');

describe('selection helpers', () => {
  it('rejects empty and whitespace selections', () => {
    expect(isUsefulSelection('')).toBe(false);
    expect(isUsefulSelection('   \n ')).toBe(false);
    expect(isUsefulSelection('x')).toBe(false);
    expect(isUsefulSelection('ok')).toBe(true);
  });

  it('builds numbered context before and after the selection', () => {
    const window = buildContextWindow(documentText, 3, 3, 1);
    expect(window.before).toContain('   2 | line two');
    expect(window.before).not.toContain('line one');
    expect(window.after).toContain('   4 | line four');
    expect(window.after).not.toContain('line five');
    expect(window.startLine).toBe(3);
    expect(window.endLine).toBe(3);
  });

  it('clamps lines to the document bounds', () => {
    const window = buildContextWindow(documentText, 99, 120, 10);
    expect(window.startLine).toBe(5);
    expect(window.endLine).toBe(5);
    expect(window.before).toContain('   4 | line four');
  });

  it('returns empty context at the edges', () => {
    const window = buildContextWindow(documentText, 1, 1, 0);
    expect(window.before).toBe('');
    expect(window.after).toBe('');
  });

  it('caps long individual lines', () => {
    const window = buildContextWindow(`head\n${'x'.repeat(800)}\ntail`, 1, 1, 1);
    expect(window.after.length).toBeLessThan(500);
    expect(window.after).toContain('…');
  });
});
