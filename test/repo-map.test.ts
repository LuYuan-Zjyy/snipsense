import { describe, expect, it } from 'vitest';
import {
  buildRepoGuideMessages,
  buildRepoMap,
  buildRepoMapSummary,
  type RepoSourceFile,
} from '../src/core/repo-map';
import type { AppSettings } from '../src/core/types';

const sources: RepoSourceFile[] = [
  {
    path: 'src/index.ts',
    language: 'typescript',
    text: "import { add } from './math';\nimport { total } from './use';\nconsole.log(add(total([1, 2]), 1));\n",
  },
  {
    path: 'src/math.ts',
    language: 'typescript',
    text: 'export function add(left: number, right: number) {\n  return left + right;\n}\n',
  },
  {
    path: 'src/use.ts',
    language: 'typescript',
    text: "import { add } from './math';\nexport function total(values: number[]) {\n  return values.reduce((sum, value) => add(sum, value), 0);\n}\n",
  },
  {
    path: 'py/vit.py',
    language: 'python',
    text: 'import torch\nfrom layer import PPEmb\n\nclass ViT(torch.nn.Module):\n    def __init__(self):\n        self.ppe = PPEmb(224, 16)\n',
  },
  {
    path: 'py/layer.py',
    language: 'python',
    text: 'from torch import nn\n\nclass PPEmb(nn.Module):\n    pass\n',
  },
];

const settings: AppSettings = {
  provider: 'deepseek',
  apiBase: '',
  model: '',
  outputLanguage: 'zh-CN',
  explainStyle: 'concise',
  autoExplain: true,
  inlineGloss: true,
  debounceMs: 550,
  contextLines: 12,
  maxSelectionChars: 12000,
  maxTokens: 620,
  temperature: 0.2,
  showStatusBar: true,
  multiFile: true,
  maxRelatedFiles: 5,
  maxUsages: 6,
  quickJump: true,
};

describe('buildRepoMap', () => {
  it('builds edges across TypeScript and adjacent Python files', () => {
    const map = buildRepoMap(sources, { rootName: 'demo' });
    expect(map.scannedFiles).toBe(5);
    expect(map.entryPoints).toContain('src/index.ts');
    expect(map.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'src/index.ts', to: 'src/math.ts' }),
        expect.objectContaining({ from: 'src/index.ts', to: 'src/use.ts' }),
        expect.objectContaining({ from: 'src/use.ts', to: 'src/math.ts' }),
        expect.objectContaining({ from: 'py/vit.py', to: 'py/layer.py' }),
      ]),
    );
    expect(map.edges.some((edge) => edge.to === 'torch')).toBe(false);
  });

  it('finds key files and exported symbols', () => {
    const map = buildRepoMap(sources, { rootName: 'demo' });
    expect(map.keyFiles).toEqual(expect.arrayContaining(['src/index.ts', 'src/math.ts']));
    const math = map.files.find((file) => file.path === 'src/math.ts');
    expect(math?.symbols).toContain('add');
    expect(math?.inDegree).toBeGreaterThanOrEqual(2);
    const layer = map.files.find((file) => file.path === 'py/layer.py');
    expect(layer?.symbols).toContain('PPEmb');
  });

  it('boosts the focused file and its neighbours', () => {
    const withoutFocus = buildRepoMap(sources, { rootName: 'demo' });
    const withFocus = buildRepoMap(sources, {
      rootName: 'demo',
      focusPath: 'src/use.ts',
    });
    const before = withoutFocus.files.find((file) => file.path === 'src/use.ts')?.score ?? 0;
    const after = withFocus.files.find((file) => file.path === 'src/use.ts')?.score ?? 0;
    expect(after).toBeGreaterThan(before);
    expect(withFocus.focus).toBe('src/use.ts');
  });

  it('formats a bounded map for the model', () => {
    const map = buildRepoMap(sources, { rootName: 'demo' });
    const summary = buildRepoMapSummary(map);
    expect(summary).toContain('src/index.ts');
    expect(summary).toContain('src/use.ts -> src/math.ts');
    expect(summary).toContain('py/vit.py -> py/layer.py');
    expect(summary).toContain('关键文件');

    const messages = buildRepoGuideMessages(map, settings);
    expect(messages[0]?.content).toContain('阅读路线');
    expect(messages[1]?.content).toContain('src/math.ts');
  });
});
