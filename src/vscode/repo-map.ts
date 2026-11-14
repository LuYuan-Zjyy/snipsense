import * as vscode from 'vscode';
import { buildRepoMap, type RepoMap, type RepoSourceFile } from '../core/repo-map';

const MAX_FILES = 1200;
const MAX_BYTES = 180_000;
const READ_CONCURRENCY = 8;

const INCLUDE =
  '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,pyi,java,kt,kts,go,rs,vue,svelte,c,cc,cpp,h,hpp,cs}';
const EXCLUDE =
  '**/{node_modules,.git,.hg,.svn,dist,build,out,coverage,.next,.nuxt,.turbo,.cache,target,vendor,venv,.venv,__pycache__,site-packages}/**';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.go': 'go',
  '.rs': 'rust',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
};

export interface RepoScanResult {
  map: RepoMap;
  sources: RepoSourceFile[];
  rootUri: vscode.Uri;
}

export async function scanWorkspaceRepoMap(
  focusUri: vscode.Uri | undefined,
  onProgress?: (message: string) => void,
): Promise<RepoScanResult | undefined> {
  const folder = focusUri
    ? (vscode.workspace.getWorkspaceFolder(focusUri) ?? vscode.workspace.workspaceFolders?.[0])
    : vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;

  onProgress?.('正在查找代码文件…');
  const found = await vscode.workspace.findFiles(INCLUDE, EXCLUDE, MAX_FILES + 1);
  const candidates = found
    .filter((uri) => shouldRead(uri))
    .sort((left, right) => left.fsPath.localeCompare(right.fsPath));
  const selected = candidates.slice(0, MAX_FILES);
  const truncated = candidates.length > MAX_FILES;

  const rootPath = folder.uri.fsPath.replace(/\\/g, '/');
  const sources: RepoSourceFile[] = [];
  let skipped = 0;
  let completed = 0;

  await mapLimit(selected, READ_CONCURRENCY, async (uri) => {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      completed += 1;
      if (completed % 20 === 0) {
        onProgress?.(`正在读取 ${completed}/${selected.length} 个文件…`);
      }
      if (bytes.byteLength > MAX_BYTES) {
        skipped += 1;
        return;
      }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (text.includes('\u0000')) {
        skipped += 1;
        return;
      }
      const path = relativePath(uri, rootPath);
      if (!path) return;
      sources.push({
        path,
        language: languageForPath(path),
        text,
      });
    } catch {
      skipped += 1;
    }
  });

  onProgress?.('正在计算依赖和关键文件…');
  const focusPath = focusUri ? relativePath(focusUri, rootPath) : undefined;
  const map = buildRepoMap(sources, {
    rootName: folder.name,
    focusPath,
    truncated: truncated || skipped > 0,
  });

  return { map, sources, rootUri: folder.uri };
}

function shouldRead(uri: vscode.Uri): boolean {
  const path = uri.fsPath.replace(/\\/g, '/');
  if (/\.min\.(js|css)$/i.test(path)) return false;
  if (/\.(map|lock)$/i.test(path)) return false;
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(path)) return false;
  return true;
}

function relativePath(uri: vscode.Uri, rootPath: string): string | undefined {
  const path = uri.fsPath.replace(/\\/g, '/');
  if (!path.startsWith(`${rootPath}/`)) return undefined;
  return path.slice(rootPath.length + 1);
}

function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf('.'));
  return LANGUAGE_BY_EXTENSION[extension] ?? 'text';
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = index;
      index += 1;
      results[current] = await worker(values[current] as T);
    }
  });
  await Promise.all(runners);
  return results;
}
