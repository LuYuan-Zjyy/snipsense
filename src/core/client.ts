import type { ChatMessage, ProviderId } from './types';
import { createSseParser, extractApiError, extractDelta } from './sse';
import { isAbortError } from './text';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export interface LlmConfig {
  provider: ProviderId;
  endpoint: string;
  model: string;
  apiKey?: string;
  maxTokens: number;
  temperature: number;
  timeoutMs?: number;
}

export class LlmError extends Error {
  readonly status?: number;
  readonly detail?: string;

  constructor(message: string, options: { status?: number; detail?: string } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = options.status;
    this.detail = options.detail;
  }
}

export interface StreamOptions {
  signal?: AbortSignal;
}

/**
 * Minimal OpenAI-compatible streaming client. Works with DeepSeek, OpenAI,
 * SiliconFlow, Ollama and most gateways that expose /chat/completions.
 */
export async function* streamChat(
  config: LlmConfig,
  messages: ChatMessage[],
  options: StreamOptions = {},
): AsyncGenerator<string> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = config.timeoutMs ?? 90_000;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      throw abortError();
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await requestWithRetry(config, messages, controller.signal);
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

    if (contentType.includes('application/json')) {
      const payload: unknown = await response.json();
      const error = extractApiError(payload);
      if (error) throw new LlmError(friendlyMessage(200, error), { detail: error });
      const text = extractDelta(payload);
      if (!text) throw new LlmError('模型返回了空内容，请重试或换一个模型。');
      yield text;
      return;
    }

    if (!response.body) {
      throw new LlmError('模型服务没有返回响应体。');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const queue: string[] = [];
    let streamError: LlmError | undefined;
    let sawContent = false;
    let sawDone = false;

    const parser = createSseParser((data) => {
      if (data === '[DONE]') {
        sawDone = true;
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        // A few local gateways send raw text chunks. Keep them if they look useful.
        if (data.trim() && data.trim() !== 'null') queue.push(data);
        return;
      }
      const apiError = extractApiError(payload);
      if (apiError) {
        streamError = new LlmError(friendlyMessage(200, apiError), { detail: apiError });
        return;
      }
      const delta = extractDelta(payload);
      if (delta) queue.push(delta);
    });

    while (!sawDone) {
      const { value, done } = await reader.read();
      if (value) parser.push(decoder.decode(value, { stream: true }));
      while (queue.length > 0) {
        sawContent = true;
        yield queue.shift() as string;
      }
      if (streamError) throw streamError;
      if (done) break;
    }

    if (sawDone) {
      try {
        await reader.cancel();
      } catch {
        // The server may already have closed the stream.
      }
    }

    parser.push(decoder.decode());
    parser.end();
    while (queue.length > 0) {
      sawContent = true;
      yield queue.shift() as string;
    }
    if (streamError) throw streamError;

    if (!sawContent) {
      throw new LlmError('模型没有返回内容。可能是接口不兼容流式输出，或模型名不正确。');
    }
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    if (timedOut) {
      throw new LlmError('请求超时（90 秒）。网络较慢或模型服务无响应，请稍后重试。');
    }
    if (isAbortError(error)) throw abortError();
    if (error instanceof LlmError) throw error;
    throw new LlmError('请求失败，请检查网络和模型配置。', {
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function requestWithRetry(
  config: LlmConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': 'SnipSense/0.1.0',
  };
  if (config.apiKey?.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  const body = JSON.stringify({
    model: config.model,
    messages,
    stream: true,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers,
        body,
        signal,
      });

      if (response.ok) {
        return response;
      }

      const text = await safeReadText(response);
      const apiDetail = parseErrorBody(text);
      const error = new LlmError(friendlyMessage(response.status, apiDetail), {
        status: response.status,
        detail: apiDetail || text.slice(0, 800),
      });

      if (attempt === 0 && RETRYABLE_STATUS.has(response.status)) {
        lastError = error;
        await delay(600);
        continue;
      }
      throw error;
    } catch (error) {
      if (signal.aborted || error instanceof LlmError) throw error;
      lastError = error;
      if (attempt === 0) {
        await delay(600);
        continue;
      }
      throw new LlmError('无法连接到模型服务。检查网络、API 地址，或确认本地 Ollama 已启动。', {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof LlmError
    ? lastError
    : new LlmError('请求失败，请稍后重试。', {
        detail: lastError instanceof Error ? lastError.message : String(lastError),
      });
}

function friendlyMessage(status: number, detail: string): string {
  if (status === 200 && detail.trim()) return `模型返回错误：${truncateDetail(detail)}`;
  if (status === 401) return 'API Key 无效或已过期。请运行「SnipSense: 设置模型与 API Key」检查。';
  if (status === 403) return '没有访问该模型的权限，请检查账号或模型权限。';
  if (status === 404) return '接口或模型不存在。请检查 API 地址和模型名。';
  if (status === 402) return '账户额度不足，请检查模型服务的余额。';
  if (status === 429) return '请求太频繁或额度受限，请稍后再试。';
  if (status >= 500) return `模型服务暂时不可用（HTTP ${status}），请稍后重试。`;
  if (detail.trim()) return `模型服务返回错误（HTTP ${status}）：${truncateDetail(detail)}`;
  return `模型服务返回错误（HTTP ${status}）。`;
}

function truncateDetail(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > 180 ? `${clean.slice(0, 179)}…` : clean;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseErrorBody(text: string): string {
  if (!text.trim()) return '';
  try {
    const payload: unknown = JSON.parse(text);
    return extractApiError(payload) || text;
  } catch {
    return text;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}
