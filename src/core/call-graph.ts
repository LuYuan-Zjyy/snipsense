import { parseImports, resolveImportCandidates } from './graph';

export type CallNodeKind = 'function' | 'method' | 'class';

export interface CallNode {
  id: string;
  name: string;
  qualifiedName: string;
  file: string;
  language: string;
  line: number;
  character: number;
  className?: string;
  kind: CallNodeKind;
}

export interface CallEdge {
  from: string;
  to: string;
  line: number;
}

export interface CallGraph {
  nodes: CallNode[];
  edges: CallEdge[];
  roots: string[];
  focus?: string;
  truncated: boolean;
}

export interface CallSourceFile {
  path: string;
  language: string;
  text: string;
}

interface ParsedFunction {
  name: string;
  className?: string;
  line: number;
  character: number;
  bodyStart: number;
  bodyEnd: number;
  kind: 'function' | 'method';
}

interface ParsedClass {
  name: string;
  line: number;
}

interface RawCall {
  name: string;
  receiver?: string;
  line: number;
}

const CALL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
  'return',
  'function',
  'def',
  'class',
  'import',
  'from',
  'new',
  'typeof',
  'sizeof',
  'case',
  'else',
  'elif',
  'except',
  'finally',
  'try',
  'do',
  'in',
  'of',
  'and',
  'or',
  'not',
  'lambda',
  'assert',
  'raise',
  'yield',
  'await',
  'async',
  'const',
  'let',
  'var',
]);

export function buildCallGraph(sources: CallSourceFile[], focusPath?: string): CallGraph {
  const nodes: CallNode[] = [];
  const classes = new Map<string, ParsedClass[]>();
  const functions = new Map<string, ParsedFunction[]>();
  const attributeTypes = new Map<string, Map<string, Map<string, string>>>();
  const pathSet = new Set(sources.map((source) => normalizePath(source.path)));

  for (const source of sources) {
    const path = normalizePath(source.path);
    if (isPython(source.language)) {
      const parsed = parsePython(source.text);
      classes.set(path, parsed.classes);
      functions.set(path, parsed.functions);
      attributeTypes.set(path, parsed.attributes);
    } else if (isTsLike(source.language)) {
      const parsed = parseTsLike(source.text);
      classes.set(path, parsed.classes);
      functions.set(path, parsed.functions);
      attributeTypes.set(path, parsed.attributes);
    }
  }

  for (const source of sources) {
    const path = normalizePath(source.path);
    const fileClasses = classes.get(path) ?? [];
    for (const fn of functions.get(path) ?? []) {
      const id = nodeId(path, fn.className, fn.name);
      nodes.push({
        id,
        name: fn.name,
        qualifiedName: fn.className ? `${fn.className}.${fn.name}` : fn.name,
        file: path,
        language: source.language,
        line: fn.line,
        character: fn.character,
        className: fn.className,
        kind: fn.kind,
      });
    }
    for (const cls of fileClasses) {
      const id = nodeId(path, undefined, cls.name);
      if (!nodes.some((node) => node.id === id)) {
        nodes.push({
          id,
          name: cls.name,
          qualifiedName: cls.name,
          file: path,
          language: source.language,
          line: cls.line,
          character: 0,
          kind: 'class',
        });
      }
    }
  }

  const byFile = groupBy(nodes, (node) => node.file);
  const byName = groupBy(nodes, (node) => node.name);
  const byClass = groupBy(
    nodes.filter((node) => Boolean(node.className)),
    (node) => node.className as string,
  );
  const edges: CallEdge[] = [];
  const edgeKeys = new Set<string>();
  let truncated = false;

  for (const source of sources) {
    const path = normalizePath(source.path);
    const fileFunctions = functions.get(path) ?? [];
    const imports = parseImports(source.text, source.language);

    for (const fn of fileFunctions) {
      const from = nodeId(path, fn.className, fn.name);
      const calls = extractCalls(source.text, fn.bodyStart, fn.bodyEnd, source.language);
      const attrs = attributeTypes.get(path)?.get(fn.className ?? '') ?? new Map();

      for (const call of calls) {
        const target = resolveCall({
          path,
          className: fn.className,
          call,
          imports,
          pathSet,
          byFile,
          byName,
          byClass,
          attributes: attrs,
        });
        if (!target || target === from) continue;
        const key = `${from}\u0000${target}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ from, to: target, line: call.line });
        if (edges.length >= 1800) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  const graph: CallGraph = {
    nodes: nodes.slice(0, 700),
    edges: edges.slice(0, 1800),
    roots: [],
    truncated: truncated || nodes.length > 700,
  };
  const focus = focusPath ? normalizePath(focusPath) : undefined;
  graph.roots = findRoots(graph, focus);
  graph.focus = pickFocus(graph, focus);
  return graph;
}

function parsePython(text: string): {
  functions: ParsedFunction[];
  classes: ParsedClass[];
  attributes: Map<string, Map<string, string>>;
} {
  const lines = text.split(/\r?\n/);
  const functions: ParsedFunction[] = [];
  const classes: ParsedClass[] = [];
  const classStack: Array<{ name: string; indent: number }> = [];
  const attributes = new Map<string, Map<string, string>>();

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;

    while (classStack.length > 0 && indent <= classStack[classStack.length - 1]!.indent) {
      classStack.pop();
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)/);
    if (classMatch?.[1]) {
      classes.push({ name: classMatch[1], line: index + 1 });
      classStack.push({ name: classMatch[1], indent });
      continue;
    }

    const functionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (!functionMatch?.[1]) continue;

    const name = functionMatch[1];
    const className = classStack[classStack.length - 1]?.name;
    const bodyStart = index + 1;
    let bodyEnd = bodyStart;
    while (bodyEnd < lines.length) {
      const next = lines[bodyEnd] ?? '';
      if (!next.trim()) {
        bodyEnd += 1;
        continue;
      }
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) break;
      bodyEnd += 1;
    }

    functions.push({
      name,
      className,
      line: index + 1,
      character: indent,
      bodyStart,
      bodyEnd,
      kind: className ? 'method' : 'function',
    });

    if (className && name === '__init__') {
      const typeMap = attributes.get(className) ?? new Map<string, string>();
      for (let cursor = bodyStart; cursor < bodyEnd; cursor += 1) {
        const assignment = (lines[cursor] ?? '').match(
          /self\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/,
        );
        if (assignment?.[1] && assignment[2]) typeMap.set(assignment[1], assignment[2]);
      }
      if (typeMap.size) attributes.set(className, typeMap);
    }

    index = bodyEnd - 1;
  }

  return { functions, classes, attributes };
}

function parseTsLike(text: string): {
  functions: ParsedFunction[];
  classes: ParsedClass[];
  attributes: Map<string, Map<string, string>>;
} {
  const lines = text.split(/\r?\n/);
  const functions: ParsedFunction[] = [];
  const classes: ParsedClass[] = [];
  const attributes = new Map<string, Map<string, string>>();
  let currentClass: { name: string; depth: number } | undefined;
  let braceDepth = 0;
  let pendingClass:
    | {
        name: string;
        line: number;
        depth: number;
      }
    | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    const classMatch = trimmed.match(
      /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    );
    if (classMatch?.[1] && braceDepth === 0) {
      classes.push({ name: classMatch[1], line: index + 1 });
      pendingClass = { name: classMatch[1], line: index + 1, depth: braceDepth };
    }

    const functionMatch =
      trimmed.match(
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
      ) ??
      trimmed.match(
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
      ) ??
      (currentClass
        ? trimmed.match(
            /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/,
          )
        : null);

    if (functionMatch?.[1] && !/^(if|for|while|switch|catch)$/.test(functionMatch[1])) {
      const name = functionMatch[1];
      const bodyStart = index + 1;
      let bodyEnd = bodyStart;
      let depth = 0;
      let started = false;
      for (; bodyEnd < lines.length; bodyEnd += 1) {
        const line = lines[bodyEnd] ?? '';
        for (const character of line) {
          if (character === '{') {
            depth += 1;
            started = true;
          } else if (character === '}') {
            depth -= 1;
          }
        }
        if (started && depth <= 0) {
          bodyEnd += 1;
          break;
        }
      }
      functions.push({
        name,
        className: currentClass?.name,
        line: index + 1,
        character: raw.length - raw.trimStart().length,
        bodyStart,
        bodyEnd,
        kind: currentClass ? 'method' : 'function',
      });
      if (currentClass && name === 'constructor') {
        const typeMap = attributes.get(currentClass.name) ?? new Map<string, string>();
        for (let cursor = bodyStart; cursor < bodyEnd; cursor += 1) {
          const assignment = (lines[cursor] ?? '').match(
            /this\.([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/,
          );
          if (assignment?.[1] && assignment[2]) typeMap.set(assignment[1], assignment[2]);
        }
        if (typeMap.size) attributes.set(currentClass.name, typeMap);
      }
      index = bodyEnd - 1;
      continue;
    }

    for (const character of raw) {
      if (character === '{') {
        braceDepth += 1;
        if (pendingClass) {
          currentClass = { name: pendingClass.name, depth: braceDepth };
          pendingClass = undefined;
        }
      } else if (character === '}') {
        braceDepth -= 1;
        if (currentClass && braceDepth < currentClass.depth) currentClass = undefined;
      }
    }
  }

  return { functions, classes, attributes };
}

function extractCalls(
  text: string,
  startLine: number,
  endLine: number,
  languageId: string,
): RawCall[] {
  const lines = text.split(/\r?\n/);
  const calls: RawCall[] = [];
  const python = isPython(languageId);

  for (let index = startLine; index < Math.min(endLine, lines.length); index += 1) {
    let line = lines[index] ?? '';
    line = python
      ? line.replace(/#.*$/, '')
      : line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (!line.trim()) continue;
    if (/^\s*(?:async\s+)?def\s+|^\s*(?:export\s+)?(?:async\s+)?function\s+/.test(line)) {
      continue;
    }

    const qualified =
      /((?:self|this)\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
    for (const match of line.matchAll(qualified)) {
      const receiver = match[1];
      const name = match[2];
      if (!receiver || !name || CALL_KEYWORDS.has(name)) continue;
      calls.push({ name, receiver, line: index + 1 });
    }

    const unqualified = /(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g;
    for (const match of line.matchAll(unqualified)) {
      const name = match[1];
      if (!name || CALL_KEYWORDS.has(name)) continue;
      if (line.includes(`.${name}(`)) continue;
      calls.push({ name, line: index + 1 });
    }
  }

  return calls;
}

function resolveCall(input: {
  path: string;
  className?: string;
  call: RawCall;
  imports: ReturnType<typeof parseImports>;
  pathSet: Set<string>;
  byFile: Map<string, CallNode[]>;
  byName: Map<string, CallNode[]>;
  byClass: Map<string, CallNode[]>;
  attributes: Map<string, string>;
}): string | undefined {
  const { path, className, call, imports, pathSet, byFile, byName } = input;

  if (call.receiver) {
    if (call.receiver === 'self' || call.receiver === 'this') {
      if (className) {
        const method = byFile
          .get(path)
          ?.find((node) => node.className === className && node.name === call.name);
        if (method) return method.id;
      }
    }
    const attributeMatch = call.receiver.match(/^(?:self|this)\.([A-Za-z_$][\w$]*)$/);
    if (attributeMatch?.[1]) {
      const type = input.attributes.get(attributeMatch[1]);
      if (type) {
        const method = input.byClass
          .get(type)
          ?.find((node) => node.name === call.name && node.className === type);
        if (method) return method.id;
      }
    }
  }

  const localClass = byFile
    .get(path)
    ?.find((node) => node.name === call.name && node.kind === 'class');
  if (localClass) {
    return findTargetNode(byFile.get(path) ?? [], call.name)?.id;
  }

  const local = byFile
    .get(path)
    ?.find(
      (node) =>
        node.name === call.name &&
        (node.kind === 'function' || (className && node.className === className)),
    );
  if (local) return local.id;

  const binding = imports
    .flatMap((entry) => entry.bindings.map((item) => ({ entry, item })))
    .find(({ item }) => item.localName === call.name);
  if (binding) {
    const targetFile = resolveImportFile(path, binding.entry.source, pathSet);
    if (targetFile) {
      const target = findTargetNode(byFile.get(targetFile) ?? [], binding.item.importedName);
      if (target) return target.id;
    }
  }

  if (call.receiver) {
    const classBinding = imports
      .flatMap((entry) => entry.bindings.map((item) => ({ entry, item })))
      .find(({ item }) => item.localName === call.receiver);
    if (classBinding) {
      const targetFile = resolveImportFile(path, classBinding.entry.source, pathSet);
      if (targetFile) {
        const target = findTargetNode(
          byFile.get(targetFile) ?? [],
          classBinding.item.importedName,
          call.name,
        );
        if (target) return target.id;
      }
    }
  }

  const globals = byName.get(call.name) ?? [];
  return globals.length === 1 ? globals[0]?.id : undefined;
}

function findTargetNode(
  nodes: CallNode[],
  name: string,
  methodName?: string,
): CallNode | undefined {
  if (methodName) {
    const method = nodes.find((node) => node.className === name && node.name === methodName);
    if (method) return method;
  }
  const constructor = nodes.find((node) => node.className === name && node.name === '__init__');
  if (constructor) return constructor;
  const direct = nodes.find(
    (node) => node.name === name && (node.kind === 'function' || node.kind === 'class'),
  );
  if (direct) return direct;
  return nodes.find((node) => node.className === name && node.name === 'constructor');
}

function resolveImportFile(
  fromFile: string,
  source: string,
  pathSet: Set<string>,
): string | undefined {
  for (const candidate of resolveImportCandidates(fromFile, source, 'typescript')) {
    if (pathSet.has(candidate)) return candidate;
  }
  // Retry with Python resolution when a TypeScript-style lookup misses.
  for (const candidate of resolveImportCandidates(fromFile, source, 'python')) {
    if (pathSet.has(candidate)) return candidate;
  }
  return undefined;
}

function findRoots(graph: CallGraph, focus?: string): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const preferred = graph.nodes.filter((node) =>
    /(^|\.)(main|train|run|forward|start)$/i.test(node.qualifiedName),
  );
  if (preferred.length > 0) return preferred.slice(0, 5).map((node) => node.id);

  const focusNodes = focus ? graph.nodes.filter((node) => node.file === focus) : [];
  if (focusNodes.length > 0) return focusNodes.slice(0, 3).map((node) => node.id);

  const outDegree = new Map<string, number>();
  for (const edge of graph.edges) outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
  return [...byId.values()]
    .sort((left, right) => (outDegree.get(right.id) ?? 0) - (outDegree.get(left.id) ?? 0))
    .slice(0, 4)
    .map((node) => node.id);
}

function pickFocus(graph: CallGraph, focus?: string): string | undefined {
  if (focus) {
    const fileNode = graph.nodes.find((node) => node.file === focus && node.kind !== 'class');
    if (fileNode) return fileNode.id;
  }
  return graph.roots[0];
}

function nodeId(path: string, className: string | undefined, name: string): string {
  return `${path}#${className ? `${className}.` : ''}${name}`;
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const name = key(value);
    const list = result.get(name) ?? [];
    list.push(value);
    result.set(name, list);
  }
  return result;
}

function isPython(language: string): boolean {
  return /^(python|python3)$/i.test(language);
}

function isTsLike(language: string): boolean {
  return /^(typescript|javascript|typescriptreact|javascriptreact|vue|svelte)$/i.test(language);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
