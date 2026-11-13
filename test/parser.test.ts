import { describe, expect, it } from 'vitest';
import { ExplanationStream, parseExplanation } from '../src/core/parser';

describe('ExplanationStream', () => {
  it('extracts gist and detail from the requested format', () => {
    const result = parseExplanation(
      '@@GIST@@\n把输入延迟 300ms 再同步。\n@@DETAIL@@\n- 用 `useState` 保存值\n- cleanup 取消旧定时器',
    );
    expect(result.gist).toBe('把输入延迟 300ms 再同步');
    expect(result.detail).toContain('useState');
    expect(result.detail).not.toContain('@@');
  });

  it('handles markers split across chunks', () => {
    const stream = new ExplanationStream();
    let result = stream.push('@@GIS');
    expect(result.gist).toBe('');
    result = stream.push('T@@\n一句话');
    expect(result.gist).toBe('一句话');
    result = stream.push('\n@@DET');
    expect(result.detail).toBe('');
    result = stream.push('AIL@@\n详细解释');
    expect(result.detail).toBe('详细解释');
    const final = stream.finish();
    expect(final.gist).toBe('一句话');
    expect(final.detail).toBe('详细解释');
  });

  it('falls back to the first sentence when markers are missing', () => {
    const result = parseExplanation('这段代码会缓存请求结果。它还会在失败时重试。');
    expect(result.gist).toBe('这段代码会缓存请求结果');
    expect(result.detail).toContain('失败时重试');
  });

  it('shows a short unformatted answer instead of dropping it', () => {
    const result = parseExplanation('OK');
    expect(result.gist).toBe('OK');
  });

  it('normalizes CRLF and removes leading whitespace', () => {
    const result = parseExplanation('@@GIST@@\r\n测试\r\n@@DETAIL@@\r\n  - 要点');
    expect(result.gist).toBe('测试');
    expect(result.detail).toBe('- 要点');
  });

  it('survives a gist-only response', () => {
    const result = parseExplanation('@@GIST@@\n只给一句话');
    expect(result.gist).toBe('只给一句话');
    expect(result.detail).toBe('');
  });
});
