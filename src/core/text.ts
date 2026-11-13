export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

export function truncateMiddle(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  if (max < 24) return { text: value.slice(0, max), truncated: true };

  const marker = '\n\n…（中间部分已省略）…\n\n';
  const remaining = max - marker.length;
  const head = Math.ceil(remaining * 0.6);
  const tail = remaining - head;
  return {
    text: `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`,
    truncated: true,
  };
}

export function clipLine(value: string, max = 400): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_~>#]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function firstSentence(value: string, max = 46): string {
  const text = stripMarkdown(value);
  if (!text) return '';
  const match = text.match(/^(.{1,120}?[。！？.!?])/);
  const sentence = match?.[1] ?? text;
  return truncate(sentence.replace(/[。！？.!?]+$/, ''), max);
}

export function fencedCode(code: string, language = 'text'): string {
  const longestRun = Math.max(
    0,
    ...Array.from(code.matchAll(/`+/g), (match) => match[0]?.length ?? 0),
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error &&
      (error.name === 'AbortError' || /aborted|aborterror/i.test(error.message)))
  );
}
