import { describe, expect, it } from 'vitest';
import { parseImports } from '../src/core/graph';
import {
  findDefaultExport,
  findImportBinding,
  findLocalDefinitions,
  qualifiedWordAt,
  stringLiteralAt,
  wordAt,
} from '../src/core/navigation';

describe('word and string detection', () => {
  it('finds the identifier under the cursor', () => {
    const text = 'const answer = add(1, 2);';
    const offset = text.indexOf('add') + 1;
    expect(wordAt(text, offset)).toEqual({ text: 'add', start: 15, end: 18 });
    expect(wordAt(text, -1)?.text).toBe('const');
    expect(wordAt(text, text.indexOf('2'))?.text).toBe('2');
  });

  it('finds a string literal from inside the string', () => {
    const text = "import { add } from './math';";
    const literal = stringLiteralAt(text, text.indexOf('math'));
    expect(literal?.value).toBe('./math');
    expect(text.slice(literal!.start, literal!.end + 1)).toBe("'./math'");
  });

  it('detects qualified expressions such as ns.foo', () => {
    const text = 'const value = math.add(1, 2);';
    const qualified = qualifiedWordAt(text, text.indexOf('add') + 1);
    expect(qualified?.qualifier).toBe('math');
    expect(qualified?.word.text).toBe('add');
  });
});

describe('import bindings', () => {
  const imports = parseImports(
    "import { add as plus } from './math';\nimport * as math from './math';\nimport def from './default';",
    'typescript',
  );

  it('maps an alias to its exported symbol', () => {
    const match = findImportBinding(imports, 'plus');
    expect(match?.entry.source).toBe('./math');
    expect(match?.binding).toEqual({
      localName: 'plus',
      importedName: 'add',
      kind: 'named',
    });
  });

  it('maps a namespace import', () => {
    expect(findImportBinding(imports, 'math')?.binding.kind).toBe('namespace');
    expect(findImportBinding(imports, 'def')?.binding.importedName).toBe('default');
  });
});

describe('local definitions', () => {
  it('finds TypeScript functions, constants, interfaces and aliases', () => {
    const text = [
      'export function total(values) {',
      '  return values.length;',
      '}',
      'const answer = 42;',
      'interface User { name: string }',
      'type Result = number;',
    ].join('\n');

    expect(findLocalDefinitions(text, 'total', 'typescript')[0]).toEqual({
      line: 0,
      character: 16,
    });
    expect(findLocalDefinitions(text, 'answer', 'typescript')[0]?.line).toBe(3);
    expect(findLocalDefinitions(text, 'User', 'typescript')[0]?.line).toBe(4);
    expect(findLocalDefinitions(text, 'Result', 'typescript')[0]?.line).toBe(5);
  });

  it('finds Python defs, classes and assignments', () => {
    const text = 'def helper():\n    pass\nclass Thing:\n    pass\nVALUE = 1\n';
    expect(findLocalDefinitions(text, 'helper', 'python')[0]?.line).toBe(0);
    expect(findLocalDefinitions(text, 'Thing', 'python')[0]?.line).toBe(2);
    expect(findLocalDefinitions(text, 'VALUE', 'python')[0]?.line).toBe(4);
  });

  it('finds a default export', () => {
    expect(findDefaultExport('export default function App() {}')?.line).toBe(0);
  });
});
