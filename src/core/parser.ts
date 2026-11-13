import type { Explanation } from './types';
import { firstSentence, oneLine, stripMarkdown, truncate } from './text';

const GIST_MARKER = '@@GIST@@';
const DETAIL_MARKER = '@@DETAIL@@';

export interface PartialExplanation extends Explanation {
  hasGist: boolean;
  hasDetail: boolean;
}

/**
 * Parses the two-part (gist + detail) response while it is still streaming.
 * It tolerates the markers arriving in separate chunks and falls back to the
 * first sentence when a model ignores the requested format.
 */
export class ExplanationStream {
  private raw = '';
  private gist = '';
  private detail = '';
  private finished = false;

  push(chunk: string): PartialExplanation {
    this.raw += chunk;
    this.update();
    return this.snapshot();
  }

  finish(): Explanation {
    this.finished = true;
    this.update();
    if (!this.gist && !this.detail && this.raw.trim() && !this.raw.includes(GIST_MARKER)) {
      // A short, unformatted answer is still useful; show it rather than nothing.
      this.detail = this.raw.trim();
    }
    if (!this.gist && this.detail) {
      this.gist = firstSentence(this.detail, 46);
    }
    if (!this.detail && this.gist && this.raw.trim() !== this.gist) {
      // A model may put the whole answer in the gist section. Keep it visible.
      this.detail = this.gist;
    }
    this.gist = cleanGist(this.gist);
    this.detail = cleanDetail(this.detail);
    if (this.detail === this.gist) this.detail = '';
    return { gist: this.gist, detail: this.detail };
  }

  snapshot(): PartialExplanation {
    return {
      gist: cleanGist(this.gist),
      detail: cleanDetail(this.detail),
      hasGist: Boolean(this.gist),
      hasDetail: Boolean(this.detail),
    };
  }

  get rawText(): string {
    return this.raw;
  }

  private update(): void {
    const text = this.raw.replace(/\r\n?/g, '\n');
    const gistIndex = text.indexOf(GIST_MARKER);
    const detailIndex = text.indexOf(DETAIL_MARKER);

    if (gistIndex >= 0 && detailIndex > gistIndex) {
      this.gist = text.slice(gistIndex + GIST_MARKER.length, detailIndex);
      this.detail = text.slice(detailIndex + DETAIL_MARKER.length);
      return;
    }

    if (gistIndex >= 0) {
      const afterGist = text.slice(gistIndex + GIST_MARKER.length);
      this.gist = stripPartialMarker(afterGist);
      if (this.finished) this.detail = '';
      return;
    }

    if (detailIndex >= 0) {
      this.gist = '';
      this.detail = text.slice(detailIndex + DETAIL_MARKER.length);
      return;
    }

    // No markers yet. Avoid flashing a partial marker, but after a reasonable
    // amount of text assume the model ignored the format and show the detail.
    if (text.trim().length > 280 && !text.trimEnd().endsWith('@')) {
      this.gist = '';
      this.detail = text;
    }
  }
}

export function parseExplanation(raw: string): Explanation {
  const stream = new ExplanationStream();
  stream.push(raw);
  return stream.finish();
}

function stripPartialMarker(value: string): string {
  const markers = [GIST_MARKER, DETAIL_MARKER];
  let text = value;
  for (const marker of markers) {
    for (let length = marker.length - 1; length >= 1; length -= 1) {
      if (text.endsWith(marker.slice(0, length))) {
        text = text.slice(0, -length);
        return text;
      }
    }
  }
  return text;
}

function cleanGist(value: string): string {
  let text = stripMarkdown(value)
    .replace(/^一句话(?:总结|解释)?\s*[:：]\s*/i, '')
    .replace(/^(gist|summary)\s*[:：]\s*/i, '')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .trim();

  text = oneLine(text).replace(/[。.]+$/, '');
  return truncate(text, 120);
}

function cleanDetail(value: string): string {
  return value
    .replace(new RegExp(GIST_MARKER, 'g'), '')
    .replace(new RegExp(DETAIL_MARKER, 'g'), '')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
}
