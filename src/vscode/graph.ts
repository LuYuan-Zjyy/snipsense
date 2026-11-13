import { posix } from 'node:path';
import * as vscode from 'vscode';
import {
  type GraphData,
  type ImportKind,
  type ParsedImport,
  type RelatedFile,
  type UsageSite,
  formatGraphContext,
  graphSignature,
  importedSymbolsUsed,
  parseExports,
  parseImports,
  resolveImportCandidates,
  selectedSymbolCandidates,
} from '../core/graph';
import { truncate } from '../core/text';
import type { AppSettings, SelectionContext } from '../core/types';

export interface GraphResult {
  data: GraphData;
  prompt: string;
  signature: string;
}

interface DocumentCache {
  [uri: string]: vscode.TextDocument | null | undefined;
}

/**
 * Builds a deliberately small, evidence-based cross-file view:
 * - imports in the selected file that are actually used by the selection;
 * - a definition excerpt from each resolved imported file;
 * - reference-provider call sites for the selected/exported symbol.
 *
 * It never walks node_modules and never indexes the whole workspace.
 */
export async function analyzeDependencies(
  selection: SelectionContext,
  settings: AppSettings,
  output?: vscode.OutputChannel,
): Promise<GraphResult | null> {
  if (!settings.multiFile) return null;

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.parse(selection.uri));
  } catch {
    return null;
  }

  const text = document.getText();
  const imports = parseImports(text, document.languageId);
  const exports = parseExports(text, document.languageId);
  const cache: DocumentCache = {};
  const fromFile = relativeFile(document.uri);

  if (!fromFile || !vscode.workspace.getWorkspaceFolder(document.uri)) {
    return null;
  }

  const dependencies = await findDependencies(
    document,
    fromFile,
    selection.code,
    imports,
    settings,
    cache,
    output,
  );
  const usages =
    settings.maxUsages > 0
      ? await findUsages(document, selection, imports, exports, settings, cache, output)
      : { items: [], truncated: false };

  const data: GraphData = {
    dependencies: dependencies.items,
    usages: usages.items,
    truncated: dependencies.truncated || usages.truncated,
  };
  const prompt = formatGraphContext(data, settings.outputLanguage);

  if (output) {
    output.appendLine(
      `[graph] ${data.dependencies.length} deps, ${data.usages.length} usages, ${prompt.length} chars`,
    );
  }

  return {
    data,
    prompt,
    signature: graphSignature(data),
  };
}

async function findDependencies(
  document: vscode.TextDocument,
  fromFile: string,
  selectedCode: string,
  imports: ParsedImport[],
  settings: AppSettings,
  cache: DocumentCache,
  output?: vscode.OutputChannel,
): Promise<{ items: RelatedFile[]; truncated: boolean }> {
  const used = new Set(importedSymbolsUsed(selectedCode, imports));
  const relevant = imports.filter((entry) => {
    if (entry.symbols.length === 0) return entry.kind === 'side-effect';
    return entry.symbols.some((symbol) => symbol !== '*' && used.has(symbol));
  });

  // Side-effect imports are always relevant: they change runtime behaviour even
  // when no symbol is referenced.
  const candidates = (relevant.length > 0 ? relevant : imports).filter(
    (entry) => relevant.length > 0 || entry.kind === 'side-effect',
  );

  const items: RelatedFile[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const entry of candidates) {
    if (items.length >= settings.maxRelatedFiles) {
      truncated = true;
      break;
    }

    const symbols = entry.symbols.filter(
      (symbol) => symbol !== '*' && (used.has(symbol) || entry.kind === 'side-effect'),
    );
    const resolved = await resolveImportDocument(document, fromFile, entry, cache);
    if (!resolved) continue;

    const key = resolved.uri.toString();
    if (seen.has(key)) continue;
    seen.add(key);

    const dependencyText = resolved.document.getText();
    const definitionLine = findDefinitionLine(
      dependencyText,
      symbols[0] ?? '',
      resolved.document.languageId,
    );
    const excerpt = excerptAround(dependencyText, definitionLine, 10);

    items.push({
      uri: key,
      file: relativeFile(resolved.uri) || resolved.uri.path,
      line: definitionLine,
      symbols,
      reason: dependencyReason(symbols, entry.kind),
      excerpt,
    });
  }

  if (items.length > 0 && items.length === settings.maxRelatedFiles) truncated = true;
  if (truncated && output) output.appendLine('[graph] dependency list truncated');
  return { items, truncated };
}

async function findUsages(
  document: vscode.TextDocument,
  selection: SelectionContext,
  imports: ParsedImport[],
  exports: string[],
  settings: AppSettings,
  cache: DocumentCache,
  output?: vscode.OutputChannel,
): Promise<{ items: UsageSite[]; truncated: boolean }> {
  const exported = new Set(exports);
  const imported = new Set(imports.flatMap((entry) => entry.symbols));
  const declared = new Set(selectedSymbolCandidates(selection.code, imports, exports));
  const candidates = selectedSymbolCandidates(selection.code, imports, exports)
    .filter((symbol) => exported.has(symbol) || imported.has(symbol) || declared.has(symbol))
    .slice(0, 2);

  if (candidates.length === 0) return { items: [], truncated: false };

  const items: UsageSite[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const symbol of candidates) {
    const position = findPosition(document, selection, symbol);
    if (!position) continue;

    const locations = await withTimeout(
      vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        document.uri,
        position,
        { includeDeclaration: true },
      ),
      2500,
    );

    if (!locations) {
      if (output) output.appendLine(`[graph] reference provider timed out for ${symbol}`);
      continue;
    }

    for (const location of locations) {
      if (overlapsSelection(location, document, selection)) continue;
      if (location.uri.scheme !== 'file' && location.uri.scheme !== 'untitled') continue;

      const refDocument = await openDocument(location.uri, cache);
      if (!refDocument) continue;

      const line = location.range.start.line;
      if (line < 0 || line >= refDocument.lineCount) continue;
      const lineText = refDocument.lineAt(line).text.trim();
      if (!lineText || isDeclarationLine(lineText, symbol) || isImportLine(lineText)) continue;

      const key = `${location.uri.toString()}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        uri: location.uri.toString(),
        file: relativeFile(location.uri) || location.uri.path,
        line: line + 1,
        symbol,
        snippet: truncate(lineText, 160),
      });

      if (items.length >= settings.maxUsages) {
        truncated = true;
        break;
      }
    }

    if (items.length >= settings.maxUsages) break;
  }

  if (truncated && output) output.appendLine('[graph] usage list truncated');
  return { items, truncated };
}

async function resolveImportDocument(
  document: vscode.TextDocument,
  fromFile: string,
  entry: ParsedImport,
  cache: DocumentCache,
): Promise<{ uri: vscode.Uri; document: vscode.TextDocument } | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) return undefined;

  const candidates = resolveImportCandidates(fromFile, entry.source, document.languageId).slice(
    0,
    8,
  );
  for (const candidate of candidates) {
    const uri = vscode.Uri.joinPath(folder.uri, candidate);
    if (!isInside(folder.uri, uri)) continue;

    const doc = await openDocument(uri, cache);
    if (!doc) continue;
    if (doc.uri.toString() === document.uri.toString()) continue;
    return { uri, document: doc };
  }

  return undefined;
}

async function openDocument(
  uri: vscode.Uri,
  cache: DocumentCache,
): Promise<vscode.TextDocument | undefined> {
  const key = uri.toString();
  if (cache[key] !== undefined) return cache[key] ?? undefined;

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (!(stat.type & vscode.FileType.File)) {
      cache[key] = null;
      return undefined;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    cache[key] = document;
    return document;
  } catch {
    cache[key] = null;
    return undefined;
  }
}

function findPosition(
  document: vscode.TextDocument,
  selection: SelectionContext,
  symbol: string,
): vscode.Position | undefined {
  const start = new vscode.Position(
    Math.max(0, selection.startLine - 1),
    Math.max(0, selection.startCharacter),
  );
  const offset = document.offsetAt(start);
  const selected = selection.code;
  const index = findWord(selected, symbol);
  if (index >= 0) return document.positionAt(offset + index);

  const text = document.getText();
  const fallback = findWord(text, symbol);
  return fallback >= 0 ? document.positionAt(fallback) : undefined;
}

function findWord(text: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).exec(text);
  return match?.index ?? -1;
}

function findDefinitionLine(text: string, symbol: string, languageId: string): number {
  if (!symbol) {
    const defaultMatch = /\bexport\s+default\b/.exec(text);
    return defaultMatch ? lineAt(text, defaultMatch.index) : 1;
  }

  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tsPattern = new RegExp(
    `\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+${escaped}\\b`,
  );
  const pythonPattern = new RegExp(
    `^\\s*(?:async\\s+)?(?:def|class)\\s+${escaped}\\b|^\\s*${escaped}\\s*=`,
    'm',
  );
  const genericPattern = new RegExp(`\\b${escaped}\\b`);

  const pattern = /^(python|python3)$/i.test(languageId)
    ? pythonPattern
    : /^(typescript|javascript|typescriptreact|javascriptreact|vue|svelte)$/i.test(languageId)
      ? tsPattern
      : genericPattern;
  const match = pattern.exec(text);
  return match ? lineAt(text, match.index) : 1;
}

function excerptAround(text: string, line: number, radius: number): string {
  const lines = text.split(/\r?\n/);
  const target = Math.max(1, Math.min(lines.length, line));
  const start = Math.max(0, target - 1 - radius);
  const end = Math.min(lines.length, target + radius);
  const excerpt = lines
    .slice(start, end)
    .map((value, index) => `${String(start + index + 1).padStart(4, ' ')} | ${value}`)
    .join('\n');
  return truncate(excerpt, 1600);
}

function dependencyReason(symbols: string[], kind: ImportKind): string {
  if (kind === 'side-effect') return '副作用导入';
  if (symbols.length === 0) return kind === 're-export' ? '重新导出' : '模块导入';
  return `导入了 ${symbols.join('、')}`;
}

function overlapsSelection(
  location: vscode.Location,
  document: vscode.TextDocument,
  selection: SelectionContext,
): boolean {
  if (location.uri.toString() !== document.uri.toString()) return false;
  const line = location.range.start.line + 1;
  return line >= selection.startLine && line <= selection.endLine;
}

function isDeclarationLine(line: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\b(?:function|class|const|let|var|interface|type|enum|def)\\s+${escaped}\\b`,
  ).test(line);
}

function isImportLine(line: string): boolean {
  if (/^\s*import\b/.test(line)) return true;
  if (/^\s*from\b/.test(line)) return true;
  return /^\s*export\b/.test(line) && /\bfrom\b/.test(line);
}

function relativeFile(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  if (!relative || posix.isAbsolute(relative) || relative.startsWith('../')) return undefined;
  return relative;
}

function isInside(root: vscode.Uri, candidate: vscode.Uri): boolean {
  return candidate.path === root.path || candidate.path.startsWith(`${root.path}/`);
}

async function withTimeout<T>(promise: Thenable<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(promise).catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}
