import { describe, expect, it } from 'vitest';
import {
  type GraphData,
  formatGraphContext,
  graphDataFromView,
  graphSignature,
  importedSymbolsUsed,
  parseExports,
  parseImports,
  resolveImportCandidates,
  selectedSymbolCandidates,
  toGraphView,
} from '../src/core/graph';

describe('TypeScript and JavaScript imports', () => {
  const source = `
    import defaultExport, { foo as bar, baz } from './dep';
    import type { T } from '../types';
    import './side-effect';
    const cjs = require('./cjs');
    const lazy = await import('./lazy');
    export { re } from './re-export';
  `;

  it('parses default, named, type, side-effect, require and dynamic imports', () => {
    const imports = parseImports(source, 'typescript');
    const dep = imports.find((entry) => entry.source === './dep');
    expect(dep?.symbols).toEqual(expect.arrayContaining(['defaultExport', 'foo', 'bar', 'baz']));
    expect(imports.find((entry) => entry.source === '../types')?.symbols).toEqual(['T']);
    expect(imports.find((entry) => entry.source === './side-effect')?.kind).toBe('side-effect');
    expect(imports.find((entry) => entry.source === './cjs')?.symbols).toEqual(['cjs']);
    expect(imports.find((entry) => entry.source === './lazy')?.kind).toBe('dynamic');
    expect(imports.find((entry) => entry.source === './re-export')?.kind).toBe('re-export');
  });

  it('keeps local-to-exported bindings for aliases and namespaces', () => {
    const imports = parseImports(
      "import def, { add as plus } from './math';\nimport * as ns from './ns';",
      'typescript',
    );
    const math = imports.find((entry) => entry.source === './math');
    expect(math?.bindings).toEqual(
      expect.arrayContaining([
        { localName: 'def', importedName: 'default', kind: 'default' },
        { localName: 'plus', importedName: 'add', kind: 'named' },
      ]),
    );
    expect(imports.find((entry) => entry.source === './ns')?.bindings).toEqual([
      { localName: 'ns', importedName: '*', kind: 'namespace' },
    ]);
  });

  it('finds imported symbols used in the selection', () => {
    const imports = parseImports(source, 'typescript');
    expect(importedSymbolsUsed('const value = baz(bar(x));', imports)).toEqual(
      expect.arrayContaining(['bar', 'baz']),
    );
    expect(importedSymbolsUsed('const value = other(x);', imports)).not.toContain('baz');
  });

  it('detects declarations and imported symbols as reference candidates', () => {
    const imports = parseImports(source, 'typescript');
    const candidates = selectedSymbolCandidates(
      'export function total(values) { return values.reduce((sum, value) => bar(sum, value), 0); }',
      imports,
      parseExports(source, 'typescript'),
    );
    expect(candidates).toEqual(expect.arrayContaining(['total', 'bar']));
  });
});

describe('Python imports and exports', () => {
  it('parses relative and absolute imports', () => {
    const imports = parseImports(
      'from .utils import helper, Thing as T\nimport os, pkg.mod as pm\n',
      'python',
    );
    expect(imports.find((entry) => entry.source === '.utils')?.symbols).toEqual([
      'helper',
      'Thing',
      'T',
    ]);
    expect(imports.find((entry) => entry.source === '.utils')?.bindings).toEqual(
      expect.arrayContaining([
        { localName: 'helper', importedName: 'helper', kind: 'named' },
        { localName: 'T', importedName: 'Thing', kind: 'named' },
      ]),
    );
    expect(imports.find((entry) => entry.source === 'pkg.mod')?.bindings).toEqual([
      { localName: 'pm', importedName: 'pkg.mod', kind: 'namespace' },
    ]);
  });

  it('detects top-level Python definitions', () => {
    expect(parseExports('def helper():\n    pass\nclass Thing:\n    pass\n', 'python')).toEqual([
      'helper',
      'Thing',
    ]);
  });
});

describe('resolveImportCandidates', () => {
  it('resolves relative TypeScript imports and index files', () => {
    const candidates = resolveImportCandidates('src/use.ts', './math', 'typescript');
    expect(candidates).toContain('src/math.ts');
    expect(candidates).toContain('src/math/index.ts');
  });

  it('normalizes parent paths', () => {
    expect(resolveImportCandidates('src/use.ts', '../lib/x', 'typescript')).toContain('lib/x.ts');
  });

  it('supports common @/ and ~/ aliases', () => {
    expect(resolveImportCandidates('src/use.ts', '@/lib/x', 'typescript')).toContain(
      'src/lib/x.ts',
    );
    expect(resolveImportCandidates('src/use.ts', '~/lib/x', 'typescript')).toContain(
      'src/lib/x.ts',
    );
  });

  it('does not resolve bare npm packages', () => {
    expect(resolveImportCandidates('src/use.ts', 'react', 'typescript')).toEqual([]);
  });

  it('resolves Python relative and absolute modules', () => {
    expect(resolveImportCandidates('pkg/a.py', '.b', 'python')).toContain('pkg/b.py');
    expect(resolveImportCandidates('pkg/sub/a.py', '..b', 'python')).toContain('pkg/b.py');
    expect(resolveImportCandidates('pkg/a.py', 'pkg.b', 'python')).toContain('pkg/b.py');
    expect(resolveImportCandidates('model/vit.py', 'layer', 'python')).toContain('model/layer.py');
  });

  it('maps Java imports to source paths', () => {
    expect(resolveImportCandidates('src/a/A.java', 'com.foo.Bar', 'java')).toContain(
      'com/foo/Bar.java',
    );
  });
});

const graph: GraphData = {
  dependencies: [
    {
      uri: 'file:///workspace/src/lib/request.ts',
      file: 'src/lib/request.ts',
      line: 8,
      symbols: ['requestJson'],
      reason: '导入了 requestJson',
      excerpt: '   8 | export async function requestJson(url: string) {',
    },
  ],
  usages: [
    {
      uri: 'file:///workspace/src/pages/user.ts',
      file: 'src/pages/user.ts',
      line: 42,
      symbol: 'fetchUser',
      snippet: 'const user = await fetchUser(id);',
    },
  ],
  truncated: false,
};

describe('graph formatting', () => {
  it('formats dependencies and call sites for the prompt', () => {
    const text = formatGraphContext(graph, 'zh-CN');
    expect(text).toContain('【它依赖的文件】');
    expect(text).toContain('src/lib/request.ts:8');
    expect(text).toContain('requestJson');
    expect(text).toContain('【调用 / 使用它的位置】');
    expect(text).toContain('src/pages/user.ts:42');
  });

  it('round-trips a view without excerpts', () => {
    const view = toGraphView(graph);
    expect(view.dependencies[0]).not.toHaveProperty('excerpt');
    const restored = graphDataFromView(view);
    expect(restored.dependencies[0]?.excerpt).toBe('');
    expect(restored.usages[0]?.snippet).toContain('fetchUser');
  });

  it('changes its signature when a dependency excerpt changes', () => {
    const changed = {
      ...graph,
      dependencies: [{ ...graph.dependencies[0]!, excerpt: 'changed' }],
    };
    expect(graphSignature(graph)).not.toBe(graphSignature(changed));
  });
});
