export const PROVIDER_IDS = ['deepseek', 'openai', 'siliconflow', 'ollama', 'custom'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type OutputLanguage = 'zh-CN' | 'en';
export type ExplainStyle = 'concise' | 'standard';
export type QuickAction = 'simpler' | 'example' | 'why';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  description: string;
  baseUrl: string;
  model: string;
  requiresKey: boolean;
  envKey: string;
  docsUrl: string;
}

export interface AppSettings {
  provider: ProviderId;
  apiBase: string;
  model: string;
  outputLanguage: OutputLanguage;
  explainStyle: ExplainStyle;
  autoExplain: boolean;
  inlineGloss: boolean;
  debounceMs: number;
  contextLines: number;
  maxSelectionChars: number;
  maxTokens: number;
  temperature: number;
  showStatusBar: boolean;
}

export interface SelectionContext {
  uri: string;
  file: string;
  language: string;
  startLine: number;
  endLine: number;
  startCharacter: number;
  endCharacter: number;
  documentVersion: number;
  code: string;
  before: string;
  after: string;
  lineCount: number;
  truncated: boolean;
}

export interface SelectionView {
  file: string;
  language: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  preview: string;
  truncated: boolean;
}

export type CardStatus = 'empty' | 'setup' | 'idle' | 'loading' | 'streaming' | 'done' | 'error';

export interface Turn {
  question: string;
  answer: string;
  pending: boolean;
  error?: string;
}

export interface CardState {
  status: CardStatus;
  selection: SelectionView | null;
  gist: string;
  detail: string;
  error: string;
  provider: ProviderId;
  providerLabel: string;
  model: string;
  autoExplain: boolean;
  inlineGloss: boolean;
  pinned: boolean;
  needsSetup: boolean;
  cached: boolean;
  conversation: Turn[];
  untrusted: boolean;
  version: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Explanation {
  gist: string;
  detail: string;
}

export interface CacheEntry extends Explanation {
  at: number;
  model: string;
}
