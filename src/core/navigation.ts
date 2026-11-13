import type { ImportBinding, ParsedImport } from './graph';

export interface TextWord {
  text: string;
  start: number;
  end: number;
}

export interface DefinitionPosition {
  line: number;
  character: number;
}

export interface ImportBindingMatch {
  entry: ParsedImport;
  binding: ImportBinding;
}

export interface QualifiedWord {
  qualifier: string;
  word: TextWord;
}

export function wordAt(text: string, offset: number): TextWord | undefined {
  if (!text) return undefined;
  let cursor = Math.max(0, Math.min(text.length, offset));
  if (cursor === text.length || !isIdentifierChar(text[cursor] ?? '')) {
    if (cursor > 0 && isIdentifierChar(text[cursor - 1] ?? '')) cursor -= 1;
  }
  if (!isIdentifierChar(text[cursor] ?? '')) {
    if (cursor + 1 < text.length && isIdentifierChar(text[cursor + 1] ?? '')) cursor += 1;
    else return undefined;
  }

  let start = cursor;
  let end = cursor + 1;
  while (start > 0 && isIdentifierChar(text[start - 1] ?? '')) start -= 1;
  while (end < text.length && isIdentifierChar(text[end] ?? '')) end += 1;
  return { text: text.slice(start, end), start, end };
}

export function stringLiteralAt(
  text: string,
  offset: number,
): { value: string; start: number; end: number } | undefined {
  const cursor = Math.max(0, Math.min(text.length - 1, offset));
  const lineStart = text.lastIndexOf('\n', cursor) + 1;
  const nextNewline = text.indexOf('\n', cursor);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;

  let best:
    | {
        value: string;
        start: number;
        end: number;
        distance: number;
      }
    | undefined;

  for (const quote of ["'", '"', '`']) {
    const before = text.lastIndexOf(quote, cursor);
    if (before < lineStart) continue;
    const after = text.indexOf(quote, before + 1);
    if (after < 0 || after > lineEnd) continue;
    if (cursor < before || cursor > after) continue;
    const distance = Math.min(cursor - before, after - cursor);
    if (!best || distance < best.distance) {
      best = {
        value: text.slice(before + 1, after),
        start: before,
        end: after,
        distance,
      };
    }
  }

  return best ? { value: best.value, start: best.start, end: best.end } : undefined;
}

export function qualifiedWordAt(text: string, offset: number): QualifiedWord | undefined {
  const word = wordAt(text, offset);
  if (!word) return undefined;
  let before = word.start - 1;
  while (before >= 0 && /\s/.test(text[before] ?? '')) before -= 1;
  if (before < 0 || text[before] !== '.') return undefined;

  before -= 1;
  while (before >= 0 && /\s/.test(text[before] ?? '')) before -= 1;
  let start = before;
  while (start >= 0 && isIdentifierChar(text[start] ?? '')) start -= 1;
  const qualifier = text.slice(start + 1, before + 1);
  if (!qualifier) return undefined;
  return { qualifier, word };
}

export function findImportBinding(
  imports: ParsedImport[],
  localName: string,
): ImportBindingMatch | undefined {
  for (const entry of imports) {
    const binding = entry.bindings.find((candidate) => candidate.localName === localName);
    if (binding) return { entry, binding };
  }
  return undefined;
}

export function findLocalDefinitions(
  text: string,
  symbol: string,
  languageId: string,
): DefinitionPosition[] {
  const escaped = escapeRegExp(symbol);
  const language = languageId.toLowerCase();
  const patterns: RegExp[] = [];

  if (/^(typescript|javascript|typescriptreact|javascriptreact|vue|svelte)/.test(language)) {
    patterns.push(
      new RegExp(
        `\\b(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+${escaped}\\b`,
        'g',
      ),
    );
    if (symbol === 'default') patterns.push(/\bexport\s+default\b/g);
  } else if (/^(python|python3)$/.test(language)) {
    patterns.push(
      new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${escaped}\\b`, 'gm'),
      new RegExp(`^\\s*${escaped}\\s*=`, 'gm'),
    );
  } else {
    patterns.push(
      new RegExp(
        `\\b(?:export\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+${escaped}\\b`,
        'g',
      ),
      new RegExp(`^\\s*(?:def|class)\\s+${escaped}\\b`, 'gm'),
    );
  }

  const positions: DefinitionPosition[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (typeof match.index !== 'number') continue;
      const index = match.index + (match[0].search(new RegExp(`\\b${escaped}\\b`)) || 0);
      positions.push(indexToPosition(text, index));
      if (positions.length >= 8) break;
    }
  }

  return uniquePositions(positions).sort((left, right) => left.line - right.line);
}

export function findDefaultExport(text: string): DefinitionPosition | undefined {
  const match = /\bexport\s+default\b/.exec(text);
  return match ? indexToPosition(text, match.index) : undefined;
}

function indexToPosition(text: string, index: number): DefinitionPosition {
  const before = text.slice(0, Math.max(0, index));
  const line = before.split('\n').length - 1;
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line, character: Math.max(0, index - lineStart) };
}

function uniquePositions(positions: DefinitionPosition[]): DefinitionPosition[] {
  const seen = new Set<string>();
  return positions.filter((position) => {
    const key = `${position.line}:${position.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
