export interface SseParser {
  push(chunk: string): void;
  end(): void;
}

/**
 * A small, dependency-free SSE parser. It follows the event-stream framing
 * rules closely enough for OpenAI-compatible APIs: events are separated by a
 * blank line, and multiple `data:` lines in one event are joined with `\n`.
 */
export function createSseParser(onData: (data: string) => void): SseParser {
  let buffer = '';

  const dispatch = (block: string): void => {
    const dataLines: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith('data:')) continue;
      let value = line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      dataLines.push(value);
    }
    if (dataLines.length > 0) onData(dataLines.join('\n'));
  };

  return {
    push(chunk: string): void {
      buffer += chunk.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.trim()) dispatch(block);
        boundary = buffer.indexOf('\n\n');
      }
    },
    end(): void {
      if (buffer.trim()) dispatch(buffer);
      buffer = '';
    },
  };
}

export function extractDelta(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as
    | {
        delta?: { content?: unknown };
        message?: { content?: unknown };
        text?: unknown;
      }
    | undefined;
  const content = first?.delta?.content ?? first?.message?.content ?? first?.text;
  return contentToText(content);
}

export function extractFinishReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const reason = (choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason;
  return typeof reason === 'string' ? reason : undefined;
}

export function extractApiError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  const message = (payload as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text;
      }
      return '';
    })
    .join('');
}
