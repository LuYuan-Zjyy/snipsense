import type { AppSettings, ProviderId, ProviderPreset } from './types';

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    description: '中文解释自然，价格低',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    requiresKey: true,
    envKey: 'DEEPSEEK_API_KEY',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o mini，速度快',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    requiresKey: true,
    envKey: 'OPENAI_API_KEY',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动',
    description: '国内访问快，代码模型多',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-Coder-7B-Instruct',
    requiresKey: true,
    envKey: 'SILICONFLOW_API_KEY',
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama（本地）',
    description: '代码不出本机，无需 Key',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5-coder:7b',
    requiresKey: false,
    envKey: 'OLLAMA_API_KEY',
    docsUrl: 'https://ollama.com/download',
  },
  custom: {
    id: 'custom',
    label: '自定义接口',
    description: '任意 OpenAI 兼容服务',
    baseUrl: '',
    model: '',
    requiresKey: false,
    envKey: 'SNIPSENSE_API_KEY',
    docsUrl: '',
  },
};

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && value in PROVIDERS;
}

export function resolveModel(settings: AppSettings): string {
  const preset = PROVIDERS[settings.provider];
  return (settings.model.trim() || preset.model).trim();
}

export function resolveApiBase(settings: AppSettings): string {
  const preset = PROVIDERS[settings.provider];
  const base = (settings.apiBase.trim() || preset.baseUrl).trim();
  if (!base) {
    throw new ConfigurationError(
      '还没有填写 API 地址。运行「SnipSense: 设置模型与 API Key」完成配置。',
    );
  }
  return base;
}

/**
 * Accepts either an OpenAI-compatible base URL (`https://host/v1`) or a full
 * chat-completions URL, and returns the exact endpoint to POST to.
 */
export function normalizeEndpoint(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new ConfigurationError('API 地址不能为空。');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError('API 地址格式不正确，需要以 http:// 或 https:// 开头。');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigurationError('API 地址只支持 http:// 或 https://。');
  }

  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/chat/completions')) {
    url.pathname = `${path}/chat/completions`.replace(/\/{2,}/g, '/');
  } else {
    url.pathname = path;
  }

  return url.toString();
}

export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDERS[provider].label;
}
