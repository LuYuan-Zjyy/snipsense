import { posix } from 'node:path';
import { fencedCode, truncate } from './text';
import type { GraphView, OutputLanguage } from './types';

export type GraphLanguage = 'ts' | 'python' | 'generic';
export type ImportKind =
  | 'named'
  | 'default'
  | 'namespace'
  | 'side-effect'
  | 're-export'
  | 'require'
  | 'dynamic'
  | 'generic';

export interface ImportBinding {
  localName: string;
  importedName: string;
  kind: 'named' | 'default' | 'namespace';
}

export interface ParsedImport {
  source: string;
  symbols: string[];
  kind: ImportKind;
  bindings: ImportBinding[];
}

export interface RelatedFile {
  uri: string;
  file: string;
  line: number;
  symbols: string[];
  reason: string;
  excerpt: string;
}

export interface UsageSite {
  uri: string;
  file: string;
  line: number;
  symbol: string;
  snippet: string;
}

export interface GraphData {
  dependencies: RelatedFile[];
  usages: UsageSite[];
  truncated: boolean;
}

export function detectGraphLanguage(languageId: string): GraphLanguage {
  if (
    /^(typescript|javascript|typescriptreact|javascriptreact|vue|svelte|astro|vue-html)$/i.test(
      languageId,
    )
  ) {
    return 'ts';
  }
  if (/^(python|python3)$/i.test(languageId)) return 'python';
  return 'generic';
}

export function parseImports(text: string, languageId: string): ParsedImport[] {
  const language = detectGraphLanguage(languageId);
  const imports: ParsedImport[] = [];
  const bySource = new Map<string, ParsedImport>();

  const add = (
    source: string,
    symbols: string[],
    kind: ImportKind,
    bindings: ImportBinding[] = [],
  ): void => {
    const clean = source.trim();
    if (!clean) return;
    const normalizedSymbols = unique(symbols.map((symbol) => symbol.trim()).filter(Boolean));
    const normalizedBindings = bindings.filter((binding) => binding.localName);
    const existing = bySource.get(clean);
    if (existing) {
      existing.symbols = unique([...existing.symbols, ...normalizedSymbols]);
      existing.bindings = mergeBindings(existing.bindings, normalizedBindings);
      if (existing.symbols.length > 0 && existing.kind === 'side-effect') {
        existing.kind = kind;
      }
      return;
    }
    const entry: ParsedImport = {
      source: clean,
      symbols: normalizedSymbols,
      kind,
      bindings: normalizedBindings,
    };
    bySource.set(clean, entry);
    imports.push(entry);
  };

  if (language === 'ts') {
    const staticRe = /\b(import|export)\s+(?:type\s+)?([^;'"`]{1,280}?)\s+from\s+['"]([^'"]+)['"]/g;
    for (const match of text.matchAll(staticRe)) {
      const keyword = match[1] ?? 'import';
      const clause = match[2] ?? '';
      const source = match[3] ?? '';
      const parsed = parseTsClause(clause);
      add(
        source,
        parsed.symbols,
        keyword === 'export' ? 're-export' : parsed.kind,
        parsed.bindings,
      );
    }

    const sideEffectRe = /\bimport\s+['"]([^'"]+)['"]/g;
    for (const match of text.matchAll(sideEffectRe)) {
      add(match[1] ?? '', [], 'side-effect');
    }

    const requireRe =
      /\b(?:const|let|var)\s+(\{[^}]+\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const match of text.matchAll(requireRe)) {
      const clause = match[1] ?? '';
      const source = match[2] ?? '';
      const parsed = parseRequireClause(clause);
      add(source, parsed.symbols, 'require', parsed.bindings);
    }

    const dynamicRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const match of text.matchAll(dynamicRe)) {
      add(match[1] ?? '', [], 'dynamic');
    }
  } else if (language === 'python') {
    const fromRe = /^\s*from\s+([.\w]+)\s+import\s+([^\n#]+)/gm;
    for (const match of text.matchAll(fromRe)) {
      const source = match[1] ?? '';
      const names: string[] = [];
      const bindings: ImportBinding[] = [];
      for (const item of (match[2] ?? '').replace(/[()]/g, '').split(',')) {
        const [importedName, alias] = item.trim().split(/\s+as\s+/);
        if (!importedName || importedName === '*') continue;
        const localName = (alias ?? importedName).trim();
        names.push(importedName, localName);
        bindings.push({ localName, importedName, kind: 'named' });
      }
      add(source, names, 'named', bindings);
    }

    const importRe = /^\s*import\s+([^\n#]+)/gm;
    for (const match of text.matchAll(importRe)) {
      for (const item of (match[1] ?? '').split(',')) {
        const [moduleName, alias] = item.trim().split(/\s+as\s+/);
        if (!moduleName) continue;
        const localName = (alias ?? moduleName.split('.').pop() ?? moduleName).trim();
        add(moduleName, [localName], 'default', [
          { localName, importedName: moduleName, kind: 'namespace' },
        ]);
      }
    }
  } else {
    if (/^(java|kotlin)$/i.test(languageId)) {
      const javaRe = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm;
      for (const match of text.matchAll(javaRe)) {
        const source = match[1] ?? '';
        const localName = source.split('.').pop() ?? source;
        add(source, [localName], 'generic', [
          { localName, importedName: localName, kind: 'named' },
        ]);
      }
    }

    if (/^(go)$/i.test(languageId)) {
      const goRe = /^\s*(?:[A-Za-z_.]\s+)?["`]([^"`]+)["`]\s*$/gm;
      for (const match of text.matchAll(goRe)) {
        add(match[1] ?? '', [], 'generic');
      }
    }

    const genericRe = /\b(?:import|require|include)\b[^\n;]*?['"]([^'"]+)['"]/g;
    for (const match of text.matchAll(genericRe)) {
      add(match[1] ?? '', [], 'generic');
    }
  }

  return imports;
}

export function parseExports(text: string, languageId: string): string[] {
  const language = detectGraphLanguage(languageId);
  const names: string[] = [];

  if (language === 'ts') {
    const declarationRe =
      /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
    for (const match of text.matchAll(declarationRe)) names.push(match[1] ?? '');

    const namedRe = /\bexport\s*\{([^}]+)\}/g;
    for (const match of text.matchAll(namedRe)) {
      for (const item of (match[1] ?? '').split(',')) {
        const name = item
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name) names.push(name);
      }
    }

    if (/\bexport\s+default\b/.test(text)) names.push('default');
  } else if (language === 'python') {
    const pythonRe = /^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/gm;
    for (const match of text.matchAll(pythonRe)) names.push(match[1] ?? match[2] ?? '');
  } else {
    const genericRe =
      /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
    for (const match of text.matchAll(genericRe)) names.push(match[1] ?? '');
  }

  return unique(names.filter((name) => name && name !== 'default'));
}

export function importedSymbolsUsed(code: string, imports: ParsedImport[]): string[] {
  const used: string[] = [];
  for (const entry of imports) {
    for (const symbol of entry.symbols) {
      if (symbol === '*') continue;
      if (containsWord(code, symbol)) used.push(symbol);
    }
  }
  return unique(used);
}

export function selectedSymbolCandidates(
  code: string,
  imports: ParsedImport[],
  _exports: string[],
): string[] {
  const candidates: string[] = [];
  const single = code.trim().match(/^[A-Za-z_$][\w$]*$/);
  if (single?.[0]) candidates.push(single[0]);

  const declarationRe =
    /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of code.matchAll(declarationRe)) candidates.push(match[1] ?? '');

  const pythonDeclarationRe = /^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/gm;
  for (const match of code.matchAll(pythonDeclarationRe)) {
    candidates.push(match[1] ?? match[2] ?? '');
  }

  candidates.push(...importedSymbolsUsed(code, imports));
  return unique(candidates.filter(Boolean)).slice(0, 4);
}

/**
 * Returns workspace-relative candidate paths for an import source. It does not
 * touch the filesystem, so it is unit-testable and safe to call from tests.
 */
export function resolveImportCandidates(
  fromFile: string,
  source: string,
  languageId: string,
): string[] {
  const language = detectGraphLanguage(languageId);
  const clean = source
    .trim()
    .replace(/\\/g, '/')
    .replace(/[?#].*$/, '');
  if (!clean) return [];

  const fromPath = fromFile.replace(/\\/g, '/');
  const fromDir = posix.dirname(fromPath);

  if (language === 'python') {
    if (clean.startsWith('.')) return pythonRelativeCandidates(fromDir, clean);
    return pythonAbsoluteCandidates(fromDir, clean);
  }

  if (/^(java|kotlin)$/i.test(languageId) && !clean.startsWith('.')) {
    const modulePath = clean.replace(/\./g, '/');
    return fileCandidates([`${modulePath}.java`, `src/${modulePath}.java`], 'generic');
  }

  if (clean.startsWith('.')) {
    return fileCandidates([posix.normalize(`${fromDir}/${clean}`)], language);
  }

  if (language === 'ts' && (clean.startsWith('@/') || clean.startsWith('~/'))) {
    const rest = clean.slice(2);
    return fileCandidates([posix.normalize(`src/${rest}`), posix.normalize(rest)], language);
  }

  if (clean.startsWith('/')) {
    return fileCandidates([clean.replace(/^\/+/, '')], language);
  }

  // Bare package names (react, lodash, ...) are not workspace files. Do not
  // wander into node_modules; the language server handles those definitions.
  return [];
}

export function formatGraphContext(data: GraphData, language: OutputLanguage): string {
  const zh = language === 'zh-CN';
  const parts: string[] = [];

  if (data.dependencies.length > 0) {
    parts.push(zh ? '【它依赖的文件】' : 'Files this code depends on:');
    for (const dependency of data.dependencies) {
      const symbols = dependency.symbols.length ? ` · ${dependency.symbols.join(', ')}` : '';
      parts.push(
        `- ${dependency.file}:${dependency.line}${symbols}${zh ? `（${dependency.reason}）` : ` (${dependency.reason})`}`,
      );
      if (dependency.excerpt) parts.push(fencedCode(dependency.excerpt, 'text'));
    }
  }

  if (data.usages.length > 0) {
    parts.push(zh ? '【调用 / 使用它的位置】' : 'Call sites and usages:');
    for (const usage of data.usages) {
      parts.push(`- ${usage.file}:${usage.line} · ${usage.symbol}`);
      if (usage.snippet) parts.push(fencedCode(usage.snippet, 'text'));
    }
  }

  if (parts.length === 0) return '';
  if (data.truncated) {
    parts.push(
      zh
        ? '（关联信息较多，以上只保留了最相关的一部分。）'
        : '(The graph was large; only the most relevant parts are included.)',
    );
  }

  return truncate(parts.join('\n\n'), 8500);
}

export function graphSignature(data: GraphData): string {
  return JSON.stringify({
    dependencies: data.dependencies.map((dependency) => ({
      uri: dependency.uri,
      line: dependency.line,
      symbols: dependency.symbols,
      excerpt: dependency.excerpt,
    })),
    usages: data.usages.map((usage) => ({
      uri: usage.uri,
      line: usage.line,
      symbol: usage.symbol,
      snippet: usage.snippet,
    })),
    truncated: data.truncated,
  });
}

export function toGraphView(data: GraphData): GraphView {
  return {
    dependencies: data.dependencies.map((dependency) => ({
      file: dependency.file,
      uri: dependency.uri,
      line: dependency.line,
      symbols: dependency.symbols,
      reason: dependency.reason,
    })),
    usages: data.usages.map((usage) => ({
      file: usage.file,
      uri: usage.uri,
      line: usage.line,
      symbol: usage.symbol,
      snippet: usage.snippet,
    })),
    truncated: data.truncated,
  };
}

export function graphDataFromView(view: GraphView): GraphData {
  return {
    dependencies: view.dependencies.map((dependency) => ({
      file: dependency.file,
      uri: dependency.uri,
      line: dependency.line,
      symbols: dependency.symbols,
      reason: dependency.reason,
      excerpt: '',
    })),
    usages: view.usages.map((usage) => ({ ...usage })),
    truncated: view.truncated,
  };
}

function parseTsClause(raw: string): {
  symbols: string[];
  kind: ImportKind;
  bindings: ImportBinding[];
} {
  const clause = raw.replace(/^type\s+/i, '').trim();
  if (clause === '*') return { symbols: ['*'], kind: 'namespace', bindings: [] };

  const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespace?.[1]) {
    return {
      symbols: [namespace[1]],
      kind: 'namespace',
      bindings: [{ localName: namespace[1], importedName: '*', kind: 'namespace' }],
    };
  }

  const symbols: string[] = [];
  const bindings: ImportBinding[] = [];
  const namedMatch = clause.match(/\{([\s\S]*)\}/);
  if (namedMatch?.[1]) {
    for (const item of namedMatch[1].split(',')) {
      const clean = item.replace(/^type\s+/i, '').trim();
      if (!clean) continue;
      const [sourceName, alias] = clean.split(/\s+as\s+/).map((part) => part.trim());
      if (!sourceName) continue;
      const localName = (alias ?? sourceName).trim();
      symbols.push(sourceName);
      if (localName !== sourceName) symbols.push(localName);
      bindings.push({ localName, importedName: sourceName, kind: 'named' });
    }
  }

  const beforeBraces = clause.split('{')[0]?.replace(/,\s*$/, '').trim() ?? '';
  if (beforeBraces && !beforeBraces.startsWith('*') && /^[A-Za-z_$]/.test(beforeBraces)) {
    symbols.unshift(beforeBraces);
    bindings.unshift({ localName: beforeBraces, importedName: 'default', kind: 'default' });
  }

  return {
    symbols: unique(symbols),
    kind: symbols.length ? 'named' : 'default',
    bindings: mergeBindings([], bindings),
  };
}

function parseRequireClause(clause: string): {
  symbols: string[];
  bindings: ImportBinding[];
} {
  const clean = clause.trim();
  if (clean.startsWith('{')) {
    const symbols: string[] = [];
    const bindings: ImportBinding[] = [];
    for (const item of clean.slice(1, -1).split(',')) {
      const [importedName, alias] = item
        .trim()
        .split(':')
        .map((part) => part.trim());
      if (!importedName) continue;
      const localName = alias ?? importedName;
      symbols.push(localName);
      bindings.push({ localName, importedName, kind: 'named' });
    }
    return { symbols, bindings };
  }
  return clean
    ? {
        symbols: [clean],
        bindings: [{ localName: clean, importedName: '*', kind: 'namespace' }],
      }
    : { symbols: [], bindings: [] };
}

function mergeBindings(existing: ImportBinding[], incoming: ImportBinding[]): ImportBinding[] {
  const merged = new Map<string, ImportBinding>();
  for (const binding of [...existing, ...incoming]) {
    if (binding.localName) merged.set(binding.localName, binding);
  }
  return [...merged.values()];
}

function pythonRelativeCandidates(fromDir: string, source: string): string[] {
  const dots = source.match(/^\.+/)?.[0].length ?? 0;
  const moduleName = source.slice(dots).replace(/\./g, '/');
  let base = fromDir;
  for (let index = 1; index < dots; index += 1) base = posix.dirname(base);
  const target = moduleName ? posix.normalize(`${base}/${moduleName}`) : base;
  return fileCandidates([`${target}.py`, `${target}/__init__.py`, `${target}/mod.py`], 'python');
}

function pythonAbsoluteCandidates(fromDir: string, source: string): string[] {
  const modulePath = source.replace(/\./g, '/');
  // Python's absolute imports are resolved against the current file directory
  // (and sys.path), not necessarily the workspace root. Try the adjacent file
  // first: this covers the common `ViT.py` + `layer.py` layout.
  const localBase = fromDir && fromDir !== '.' ? `${fromDir}/${modulePath}` : modulePath;
  return fileCandidates(
    [
      `${localBase}.py`,
      `${localBase}/__init__.py`,
      `${modulePath}.py`,
      `${modulePath}/__init__.py`,
      `src/${modulePath}.py`,
      `src/${modulePath}/__init__.py`,
    ],
    'python',
  );
}

function fileCandidates(bases: string[], language: GraphLanguage): string[] {
  const extensions =
    language === 'ts'
      ? ['.d.ts', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']
      : language === 'python'
        ? ['.py', '.pyi']
        : ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs'];

  const candidates: string[] = [];
  for (const raw of bases) {
    const base = posix.normalize(raw.replace(/^\.\//, ''));
    if (!base || base === '.' || base.startsWith('../') || base.startsWith('/')) continue;

    if (posix.extname(base)) {
      candidates.push(base);
      if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
      if (base.endsWith('.jsx')) candidates.push(`${base.slice(0, -4)}.tsx`);
      continue;
    }

    for (const extension of extensions) candidates.push(`${base}${extension}`);
    for (const extension of extensions) candidates.push(`${base}/index${extension}`);
  }

  return unique(candidates).slice(0, 24);
}

function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(text);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
