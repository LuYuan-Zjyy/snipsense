import { clipLine, normalizeNewlines } from './text';

const MAX_CONTEXT_CHARS = 7000;

export interface ContextWindow {
  before: string;
  after: string;
  startLine: number;
  endLine: number;
  lineCount: number;
}

export function isUsefulSelection(text: string): boolean {
  const normalized = normalizeNewlines(text);
  if (!normalized.trim()) return false;
  if (normalized.trim().length < 2) return false;
  return true;
}

export function buildContextWindow(
  documentText: string,
  startLine: number,
  endLine: number,
  contextLines: number,
): ContextWindow {
  const lines = normalizeNewlines(documentText).split('\n');
  const total = Math.max(1, lines.length);
  const start = clamp(Math.round(startLine), 1, total);
  const end = clamp(Math.round(endLine), start, total);
  const around = clamp(Math.floor(contextLines), 0, 60);
  const beforeStart = Math.max(1, start - around);
  const afterEnd = Math.min(total, end + around);

  const beforeLines = lines.slice(beforeStart - 1, start - 1);
  const afterLines = lines.slice(end, afterEnd);

  return {
    before: formatContext(beforeLines, beforeStart, 'start'),
    after: formatContext(afterLines, end + 1, 'end'),
    startLine: start,
    endLine: end,
    lineCount: total,
  };
}

function formatContext(lines: string[], firstLine: number, side: 'start' | 'end'): string {
  if (lines.length === 0) return '';
  const numbered = lines.map((line, index) => {
    const number = String(firstLine + index).padStart(4, ' ');
    return `${number} | ${clipLine(line)}`;
  });
  let text = numbered.join('\n');
  if (text.length <= MAX_CONTEXT_CHARS) return text;

  if (side === 'start') {
    // Context immediately before the selection is more useful than the top.
    text = text.slice(text.length - MAX_CONTEXT_CHARS);
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    return `…（更早的上下文已省略）\n${text}`;
  }

  text = text.slice(0, MAX_CONTEXT_CHARS);
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline >= 0) text = text.slice(0, lastNewline);
  return `${text}\n…（更后的上下文已省略）`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
