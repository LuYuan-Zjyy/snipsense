import * as vscode from 'vscode';
import { PROVIDERS, isProviderId, resolveApiBase, resolveModel } from '../core/endpoint';
import type { AppSettings, OutputLanguage, ProviderId } from '../core/types';

const SECTION = 'snipsense';

export function readSettings(): AppSettings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const providerValue = config.get<string>('provider', 'deepseek');
  const provider: ProviderId = isProviderId(providerValue) ? providerValue : 'deepseek';
  const language = config.get<string>('outputLanguage', 'zh-CN') === 'en' ? 'en' : 'zh-CN';
  const style =
    config.get<string>('explainStyle', 'concise') === 'standard' ? 'standard' : 'concise';

  return {
    provider,
    apiBase: config.get<string>('apiBase', ''),
    model: config.get<string>('model', ''),
    outputLanguage: language as OutputLanguage,
    explainStyle: style,
    autoExplain: config.get<boolean>('autoExplain', true),
    inlineGloss: config.get<boolean>('inlineGloss', true),
    debounceMs: clamp(config.get<number>('debounceMs', 550), 200, 3000),
    contextLines: clamp(config.get<number>('contextLines', 12), 0, 60),
    maxSelectionChars: clamp(config.get<number>('maxSelectionChars', 12_000), 1000, 50_000),
    maxTokens: clamp(config.get<number>('maxTokens', 620), 120, 2000),
    temperature: clamp(config.get<number>('temperature', 0.2), 0, 1),
    showStatusBar: config.get<boolean>('showStatusBar', true),
    multiFile: config.get<boolean>('multiFile', true),
    maxRelatedFiles: clamp(config.get<number>('maxRelatedFiles', 5), 1, 12),
    maxUsages: clamp(config.get<number>('maxUsages', 6), 0, 20),
    quickJump: config.get<boolean>('quickJump', true),
  };
}

export function currentEndpoint(settings = readSettings()): string {
  return resolveApiBase(settings);
}

export function currentModel(settings = readSettings()): string {
  return resolveModel(settings);
}

export function secretKey(provider: ProviderId): string {
  return `snipsense.apiKey.${provider}`;
}

export async function getApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderId,
): Promise<string | undefined> {
  const stored = (await context.secrets.get(secretKey(provider)))?.trim();
  if (stored) return stored;

  const envName = PROVIDERS[provider].envKey;
  const fromEnv = process.env[envName]?.trim();
  return fromEnv || undefined;
}

export async function saveApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderId,
  apiKey: string,
): Promise<void> {
  const value = apiKey.trim();
  if (value) {
    await context.secrets.store(secretKey(provider), value);
  } else {
    await context.secrets.delete(secretKey(provider));
  }
}

export async function hasApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderId,
): Promise<boolean> {
  if (!PROVIDERS[provider].requiresKey) return true;
  return Boolean(await getApiKey(context, provider));
}

export function providerDocsUrl(provider: ProviderId): string {
  return PROVIDERS[provider].docsUrl;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
