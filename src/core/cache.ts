import { createHash } from 'node:crypto';
import type { CacheEntry, Explanation } from './types';

const CACHE_KEY = 'snipsense.cache.v1';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface CacheInput {
  provider: string;
  endpoint: string;
  model: string;
  language: string;
  style: string;
  code: string;
  before: string;
  after: string;
}

export function createCacheKey(input: CacheInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.provider,
        input.endpoint,
        input.model,
        input.language,
        input.style,
        input.code,
        input.before,
        input.after,
      ]),
    )
    .digest('hex');
}

export class ExplanationCache {
  private entries: Record<string, CacheEntry>;

  constructor(
    private readonly store: MementoLike,
    private readonly limit = 80,
  ) {
    this.entries = store.get<Record<string, CacheEntry>>(CACHE_KEY) ?? {};
  }

  get(key: string): CacheEntry | undefined {
    return this.entries[key];
  }

  set(key: string, explanation: Explanation, model: string): void {
    this.entries[key] = {
      gist: explanation.gist,
      detail: explanation.detail,
      model,
      at: Date.now(),
    };

    const keys = Object.keys(this.entries);
    if (keys.length > this.limit) {
      keys
        .sort((a, b) => (this.entries[a]?.at ?? 0) - (this.entries[b]?.at ?? 0))
        .slice(0, keys.length - this.limit)
        .forEach((oldKey) => {
          delete this.entries[oldKey];
        });
    }

    void this.store.update(CACHE_KEY, this.entries);
  }

  clear(): void {
    this.entries = {};
    void this.store.update(CACHE_KEY, {});
  }

  size(): number {
    return Object.keys(this.entries).length;
  }
}
