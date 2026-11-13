import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  normalizeEndpoint,
  resolveApiBase,
  resolveModel,
  isLocalEndpoint,
  endpointHost,
} from '../src/core/endpoint';
import type { AppSettings } from '../src/core/types';

const baseSettings: AppSettings = {
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
};

describe('normalizeEndpoint', () => {
  it('appends /chat/completions to a base URL', () => {
    expect(normalizeEndpoint('https://api.deepseek.com/v1/')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
  });

  it('keeps a full chat-completions URL unchanged', () => {
    expect(normalizeEndpoint('https://example.com/v1/chat/completions')).toBe(
      'https://example.com/v1/chat/completions',
    );
  });

  it('supports localhost HTTP endpoints', () => {
    expect(normalizeEndpoint('http://127.0.0.1:11434/v1')).toBe(
      'http://127.0.0.1:11434/v1/chat/completions',
    );
    expect(isLocalEndpoint('http://127.0.0.1:11434/v1/chat/completions')).toBe(true);
  });

  it('rejects invalid protocols', () => {
    expect(() => normalizeEndpoint('ftp://example.com/v1')).toThrow(ConfigurationError);
  });

  it('rejects empty input', () => {
    expect(() => normalizeEndpoint('  ')).toThrow(ConfigurationError);
  });
});

describe('settings resolution', () => {
  it('uses preset defaults', () => {
    expect(resolveApiBase(baseSettings)).toBe('https://api.deepseek.com/v1');
    expect(resolveModel(baseSettings)).toBe('deepseek-chat');
  });

  it('uses explicit overrides', () => {
    const settings = {
      ...baseSettings,
      apiBase: 'https://gateway.example.com/v1',
      model: 'my-model',
    };
    expect(resolveApiBase(settings)).toBe('https://gateway.example.com/v1');
    expect(resolveModel(settings)).toBe('my-model');
  });

  it('extracts a host for logging', () => {
    expect(endpointHost('https://api.deepseek.com/v1/chat/completions')).toBe('api.deepseek.com');
  });
});
