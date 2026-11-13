import { parseExports, parseImports, resolveImportCandidates } from './graph';
import type { AppSettings, ChatMessage, OutputLanguage } from './types';

export interface RepoSourceFile {
  path: string;
  language: string;
  text: string;
}

export interface RepoMapFile {
  path: string;
  language: string;
  symbols: string[];
  imports: string[];
  inDegree: number;
  outDegree: number;
  score: number;
  isEntry: boolean;
}

export interface RepoMapEdge {
  from: string;
  to: string;
  symbols: string[];
}

export interface RepoMap {
  rootName: string;
  files: RepoMapFile[];
  edges: RepoMapEdge[];
  entryPoints: string[];
  keyFiles: string[];
  languages: Record<string, number>;
  scannedFiles: number;
  truncated: boolean;
  focus?: string;
  generatedAt: string;
}

export interface RepoMapOptions {
  rootName: string;
  focusPath?: string;
  truncated?: boolean;
  now?: Date;
}

export function buildRepoMap(sources: RepoSourceFile[], options: RepoMapOptions): RepoMap {
  const paths = new Set(sources.map((source) => normalizePath(source.path)));
  const fileMap = new Map<string, RepoSourceFile>();
  for (const source of sources) fileMap.set(normalizePath(source.path), source);

  const edgesByKey = new Map<string, RepoMapEdge>();
  const importsByFile = new Map<string, string[]>();
  const symbolsByFile = new Map<string, string[]>();

  for (const source of sources) {
    const path = normalizePath(source.path);
    const imports = parseImports(source.text, source.language);
    const dependencyPaths: string[] = [];

    for (const entry of imports) {
      const candidates = resolveImportCandidates(path, entry.source, source.language);
      const target = candidates.find((candidate) => paths.has(candidate));
      if (!target || target === path) continue;

      dependencyPaths.push(target);
      const symbols = entry.symbols.filter((symbol) => symbol !== '*').slice(0, 8);
      const key = `${path}\u0000${target}`;
      const existing = edgesByKey.get(key);
      if (existing) {
        existing.symbols = unique([...existing.symbols, ...symbols]);
      } else {
        edgesByKey.set(key, { from: path, to: target, symbols: unique(symbols) });
      }
    }

    importsByFile.set(path, unique(dependencyPaths));
    symbolsByFile.set(path, extractSymbols(source.text, source.language));
  }

  const filesByPath = new Map<string, RepoMapFile>();
  for (const source of sources) {
    const path = normalizePath(source.path);
    filesByPath.set(path, {
      path,
      language: source.language,
      symbols: symbolsByFile.get(path) ?? [],
      imports: importsByFile.get(path) ?? [],
      inDegree: 0,
      outDegree: 0,
      score: 0,
      isEntry: false,
    });
  }

  const edges = [...edgesByKey.values()].sort((left, right) =>
    `${left.from}->${left.to}`.localeCompare(`${right.from}->${right.to}`),
  );
  for (const edge of edges) {
    const from = filesByPath.get(edge.from);
    const to = filesByPath.get(edge.to);
    if (from) from.outDegree += 1;
    if (to) to.inDegree += 1;
  }

  const entryPoints = findEntryPoints(filesByPath);
  for (const entry of entryPoints) {
    const file = filesByPath.get(entry);
    if (file) file.isEntry = true;
  }

  const focus = options.focusPath ? normalizePath(options.focusPath) : undefined;
  const rank = pageRank(filesByPath, edges, focus);
  const neighbors = new Set<string>();
  if (focus) {
    for (const edge of edges) {
      if (edge.from === focus) neighbors.add(edge.to);
      if (edge.to === focus) neighbors.add(edge.from);
    }
  }

  for (const file of filesByPath.values()) {
    const focusBoost = file.path === focus ? 18 : neighbors.has(file.path) ? 5 : 0;
    file.score = Math.round(
      (rank.get(file.path) ?? 0) * 1000 +
        file.inDegree * 3 +
        file.outDegree * 0.7 +
        (file.isEntry ? 5 : 0) +
        focusBoost,
    );
  }

  const sortedFiles = [...filesByPath.values()].sort(
    (left, right) => right.score - left.score || left.path.localeCompare(right.path),
  );
  const keyFiles = unique([
    ...entryPoints,
    ...sortedFiles.slice(0, 12).map((file) => file.path),
  ]).slice(0, 14);

  const languages: Record<string, number> = {};
  for (const file of sortedFiles) {
    languages[file.language] = (languages[file.language] ?? 0) + 1;
  }

  return {
    rootName: options.rootName,
    files: sortedFiles,
    edges,
    entryPoints,
    keyFiles,
    languages,
    scannedFiles: sources.length,
    truncated: Boolean(options.truncated),
    focus: focus && filesByPath.has(focus) ? focus : undefined,
    generatedAt: (options.now ?? new Date()).toISOString(),
  };
}

export function buildRepoMapSummary(map: RepoMap, language: OutputLanguage = 'zh-CN'): string {
  const zh = language === 'zh-CN';
  const lines: string[] = [];
  lines.push(zh ? `# 仓库地图：${map.rootName}` : `# Repository map: ${map.rootName}`);
  lines.push(
    zh
      ? `文件：${map.scannedFiles} 个；依赖边：${map.edges.length} 条；语言：${Object.entries(
          map.languages,
        )
          .map(([name, count]) => `${name} ${count}`)
          .join('、')}`
      : `Files: ${map.scannedFiles}; dependency edges: ${map.edges.length}; languages: ${Object.entries(
          map.languages,
        )
          .map(([name, count]) => `${name} ${count}`)
          .join(', ')}`,
  );

  if (map.entryPoints.length > 0) {
    lines.push('', zh ? '## 入口' : '## Entry points');
    for (const entry of map.entryPoints) lines.push(`- ${entry}`);
  }

  lines.push('', zh ? '## 关键文件' : '## Key files');
  for (const path of map.keyFiles) {
    const file = map.files.find((candidate) => candidate.path === path);
    if (!file) continue;
    const symbols = file.symbols.length ? ` · ${file.symbols.slice(0, 5).join(', ')}` : '';
    lines.push(
      `- ${file.path} (${file.language}; ${zh ? '被依赖' : 'in'} ${file.inDegree}; ${zh ? '依赖' : 'out'} ${file.outDegree}${symbols})`,
    );
  }

  if (map.edges.length > 0) {
    lines.push('', zh ? '## 依赖边' : '## Edges');
    for (const edge of map.edges.slice(0, 80)) {
      const symbols = edge.symbols.length ? ` [${edge.symbols.join(', ')}]` : '';
      lines.push(`- ${edge.from} -> ${edge.to}${symbols}`);
    }
    if (map.edges.length > 80) lines.push(zh ? '- …（省略更多边）' : '- … (more edges omitted)');
  }

  if (map.focus) lines.push('', zh ? `当前关注：${map.focus}` : `Focus: ${map.focus}`);
  if (map.truncated) {
    lines.push('', zh ? '（文件较多，地图已截断。）' : '(The map was truncated.)');
  }
  return lines.join('\n');
}

export function buildRepoGuideMessages(map: RepoMap, settings: AppSettings): ChatMessage[] {
  const zh = settings.outputLanguage === 'zh-CN';
  const summary = buildRepoMapSummary(map, settings.outputLanguage);

  if (zh) {
    return [
      {
        role: 'system',
        content: [
          '你是 SnipSense Repo Guide，一名擅长带新人读代码的资深工程师。',
          '你会收到一份静态生成的仓库地图，请为第一次接触这个仓库的工程师设计一条 30-60 分钟的阅读路线。',
          '只使用地图里出现的文件和依赖关系，不要编造不存在的文件、接口或行为。',
          '输出 Markdown，按以下结构：',
          '# 这个仓库在做什么',
          '## 先读这些文件',
          '（5 个以内，每个文件一行：路径 + 为什么先读它）',
          '## 一条核心调用链',
          '（用 a -> b -> c 表示，并解释中间发生了什么）',
          '## 建议的第一个小任务',
          '（一个能验证理解、风险低的小改动）',
          '## 还不确定的地方',
          '（明确写出地图里没有覆盖的部分）',
          '总长度控制在 600-900 个汉字，不要贴大段代码。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `请基于下面的仓库地图生成阅读路线：\n\n${summary}`,
      },
    ];
  }

  return [
    {
      role: 'system',
      content: [
        'You are SnipSense Repo Guide, a senior engineer who is excellent at onboarding people into unfamiliar repositories.',
        'You will receive a statically generated repository map. Design a 30-60 minute reading path for an engineer seeing this repo for the first time.',
        'Only use files and dependency edges present in the map. Do not invent files, APIs or behaviour.',
        'Output Markdown with these sections:',
        '# What this repository does',
        '## Read these first',
        '(up to 5 files, each with a reason)',
        '## One core call chain',
        '(a -> b -> c, with what happens between them)',
        '## A good first task',
        '(a low-risk change that proves understanding)',
        '## Open questions',
        '(what the map does not cover)',
        'Keep it under 500 words. Do not quote large code blocks.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Generate a reading path from this repository map:\n\n${summary}`,
    },
  ];
}

function extractSymbols(text: string, languageId: string): string[] {
  const symbols = new Set(parseExports(text, languageId));
  const language = languageId.toLowerCase();

  if (/^(typescript|javascript|typescriptreact|javascriptreact|vue|svelte)/.test(language)) {
    const pattern =
      /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
    for (const match of text.matchAll(pattern)) {
      if (match[1]) symbols.add(match[1]);
    }
  } else if (/^(python|python3)$/.test(language)) {
    const pattern = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm;
    for (const match of text.matchAll(pattern)) {
      if (match[1]) symbols.add(match[1]);
    }
  } else {
    const pattern = /\b(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
    for (const match of text.matchAll(pattern)) {
      if (match[1]) symbols.add(match[1]);
    }
  }

  return [...symbols].slice(0, 10);
}

function findEntryPoints(files: Map<string, RepoMapFile>): string[] {
  const entryPattern =
    /(^|\/)(index|main|app|server|cli|__main__|manage)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i;
  const direct = [...files.keys()]
    .filter((path) => entryPattern.test(path))
    .sort((left, right) => left.split('/').length - right.split('/').length)
    .slice(0, 4);
  if (direct.length > 0) return direct;

  return [...files.values()]
    .filter((file) => file.inDegree === 0 && file.outDegree > 0)
    .sort((left, right) => right.outDegree - left.outDegree)
    .slice(0, 3)
    .map((file) => file.path);
}

function pageRank(
  files: Map<string, RepoMapFile>,
  edges: RepoMapEdge[],
  focus?: string,
): Map<string, number> {
  const paths = [...files.keys()];
  const n = paths.length;
  if (n === 0) return new Map();

  const outgoing = new Map<string, string[]>();
  for (const path of paths) outgoing.set(path, []);
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);

  let rank = new Map(paths.map((path) => [path, 1 / n]));
  const damping = 0.85;

  for (let iteration = 0; iteration < 28; iteration += 1) {
    const next = new Map(paths.map((path) => [path, (1 - damping) / n]));
    let dangling = 0;

    for (const path of paths) {
      const targets = outgoing.get(path) ?? [];
      const value = rank.get(path) ?? 0;
      if (targets.length === 0) {
        dangling += value;
        continue;
      }
      for (const target of targets) {
        next.set(target, (next.get(target) ?? 0) + (damping * value) / targets.length);
      }
    }

    for (const path of paths) {
      next.set(path, (next.get(path) ?? 0) + (damping * dangling) / n);
    }

    if (focus && files.has(focus)) {
      // Personalised teleport: keep the active file and its neighbours near the
      // top without turning the map into a local ego graph.
      const focusWeight = 0.14;
      next.set(focus, (next.get(focus) ?? 0) + focusWeight);
    }

    rank = next;
  }

  return rank;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
