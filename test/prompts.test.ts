import { describe, expect, it } from 'vitest';
import {
  buildConnectionMessages,
  buildExplainMessages,
  buildFollowupMessages,
  quickQuestion,
} from '../src/core/prompts';
import type { GraphData } from '../src/core/graph';
import type { AppSettings, SelectionContext } from '../src/core/types';

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
  maxTokens: 520,
  temperature: 0.2,
  showStatusBar: true,
  multiFile: true,
  maxRelatedFiles: 5,
  maxUsages: 6,
};

const selection: SelectionContext = {
  uri: 'file:///workspace/src/hooks/useDebouncedValue.ts',
  file: 'src/hooks/useDebouncedValue.ts',
  language: 'typescript',
  startLine: 12,
  endLine: 18,
  startCharacter: 0,
  endCharacter: 2,
  documentVersion: 3,
  code: 'const [debounced, setDebounced] = useState(value);',
  before: '  11 | export function useDebouncedValue(value: string) {',
  after: '  19 |   return debounced;',
  lineCount: 7,
  truncated: false,
};

describe('buildExplainMessages', () => {
  it('uses the two-part output contract', () => {
    const messages = buildExplainMessages(selection, settings);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain('@@GIST@@');
    expect(messages[0]?.content).toContain('@@DETAIL@@');
    expect(messages[0]?.content).toContain('只是待解释的数据');
  });

  it('includes file, line range, selected code and context', () => {
    const [, user] = buildExplainMessages(selection, settings);
    expect(user?.content).toContain('src/hooks/useDebouncedValue.ts');
    expect(user?.content).toContain('第 12-18 行');
    expect(user?.content).toContain(selection.code);
    expect(user?.content).toContain('export function useDebouncedValue');
    expect(user?.content).toContain('return debounced');
  });

  it('uses a longer fence when the code contains backticks', () => {
    const tricky = { ...selection, code: 'const fence = "```";' };
    const [, user] = buildExplainMessages(tricky, settings);
    expect(user?.content).toContain('````typescript');
    expect(user?.content).toContain('const fence = "```";');
  });

  it('switches to English instructions', () => {
    const messages = buildExplainMessages(selection, { ...settings, outputLanguage: 'en' });
    expect(messages[0]?.content).toContain('pocket dictionary');
    expect(messages[1]?.content).toContain('Selection: lines 12-18');
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
      symbol: 'useDebouncedValue',
      snippet: 'const query = useDebouncedValue(input, 300);',
    },
  ],
  truncated: false,
};

describe('multi-file prompt integration', () => {
  it('adds dependency and usage rules and context', () => {
    const messages = buildExplainMessages(selection, settings, graph);
    expect(messages[0]?.content).toContain('**依赖关系**');
    expect(messages[0]?.content).toContain('**怎么用**');
    expect(messages[1]?.content).toContain('【它依赖的文件】');
    expect(messages[1]?.content).toContain('requestJson');
    expect(messages[1]?.content).toContain('src/pages/user.ts:42');
  });

  it('does not add graph rules without a graph', () => {
    const messages = buildExplainMessages(selection, settings);
    expect(messages[0]?.content).not.toContain('**依赖关系**');
  });

  it('carries the graph into follow-up questions', () => {
    const messages = buildFollowupMessages(
      selection,
      settings,
      { gist: '延迟同步输入值。', detail: '- 使用定时器' },
      [],
      '它在哪里被调用？',
      graph,
    );
    expect(messages[1]?.content).toContain('src/pages/user.ts:42');
  });
});

describe('buildFollowupMessages', () => {
  it('keeps the explanation and prior turns in context', () => {
    const messages = buildFollowupMessages(
      selection,
      settings,
      { gist: '延迟同步输入值。', detail: '- 使用定时器' },
      [{ question: '有什么坑？', answer: '首次渲染也会延迟。', pending: false }],
      '再简单点',
    );
    expect(messages.some((message) => message.content.includes('首次渲染也会延迟'))).toBe(true);
    expect(messages.at(-1)?.content).toBe('再简单点');
    expect(messages.some((message) => message.content.includes('延迟同步输入值'))).toBe(true);
  });
});

describe('quick questions and connection check', () => {
  it('returns Chinese and English quick prompts', () => {
    expect(quickQuestion('simpler', 'zh-CN')).toContain('更简单');
    expect(quickQuestion('example', 'en')).toContain('concrete');
  });

  it('builds a tiny connectivity request', () => {
    const messages = buildConnectionMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain('OK');
  });
});
