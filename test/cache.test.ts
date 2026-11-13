import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExplanationCache, createCacheKey, type MementoLike } from '../src/core/cache';

class MemoryMemento implements MementoLike {
  data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ExplanationCache', () => {
  it('stores and retrieves an explanation', () => {
    const cache = new ExplanationCache(new MemoryMemento());
    cache.set('key', { gist: '一句话', detail: '详细内容' }, 'model');
    expect(cache.get('key')?.gist).toBe('一句话');
    expect(cache.size()).toBe(1);
  });

  it('evicts the oldest entries when over the limit', () => {
    vi.useFakeTimers();
    const cache = new ExplanationCache(new MemoryMemento(), 2);
    cache.set('a', { gist: 'a', detail: '' }, 'm');
    vi.advanceTimersByTime(10);
    cache.set('b', { gist: 'b', detail: '' }, 'm');
    vi.advanceTimersByTime(10);
    cache.set('c', { gist: 'c', detail: '' }, 'm');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')?.gist).toBe('b');
    expect(cache.get('c')?.gist).toBe('c');
  });

  it('clears all entries', () => {
    const cache = new ExplanationCache(new MemoryMemento());
    cache.set('a', { gist: 'a', detail: '' }, 'm');
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe('createCacheKey', () => {
  it('is stable and sensitive to code changes', () => {
    const base = {
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      language: 'zh-CN',
      style: 'concise',
      code: 'const a = 1;',
      before: '',
      after: '',
    };
    expect(createCacheKey(base)).toBe(createCacheKey({ ...base }));
    expect(createCacheKey(base)).not.toBe(createCacheKey({ ...base, code: 'const a = 2;' }));
  });
});
