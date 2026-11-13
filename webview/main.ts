import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { CardState, QuickAction } from '../src/core/types';
import { icons } from './icons';
import './style.css';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLDivElement;

marked.setOptions({ gfm: true, breaks: true });

const state = {
  value: defaultState(),
};

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">${icons.brand}</span>
        <span class="brand-copy">
          <span class="brand-name">SnipSense</span>
          <span class="brand-tag">选中即懂</span>
        </span>
      </div>
      <div class="top-actions">
        <button id="pinButton" class="icon-btn" type="button" data-action="pin" title="固定这次解释" aria-label="固定这次解释" aria-pressed="false">${icons.pin}</button>
        <button class="icon-btn" type="button" data-action="repoMap" title="仓库地图" aria-label="仓库地图">${icons.map}</button>
        <button class="icon-btn" type="button" data-action="setup" title="设置模型" aria-label="设置模型">${icons.settings}</button>
      </div>
    </header>
    <div id="status" class="statusline" role="status" aria-live="polite"></div>
    <main id="content" class="content" tabindex="-1"></main>
    <section id="composer" class="composer" hidden>
      <div class="quick-row" id="quickRow">
        <button class="chip" type="button" data-quick="simpler">再简单点</button>
        <button class="chip" type="button" data-quick="example">举个例子</button>
        <button class="chip" type="button" data-quick="why">为什么这样写</button>
      </div>
      <div class="ask-row">
        <textarea id="question" rows="1" placeholder="继续问这段代码…" aria-label="继续问这段代码"></textarea>
        <button id="sendButton" class="send-btn" type="button" data-action="send" title="发送" aria-label="发送">${icons.send}</button>
      </div>
      <div class="composer-foot">
        <span id="composerHint">Enter 发送 · Shift+Enter 换行</span>
        <span class="privacy">仅发送选中代码与附近上下文</span>
      </div>
    </section>
  </div>
`;

const content = document.getElementById('content') as HTMLElement;
const statusLine = document.getElementById('status') as HTMLElement;
const composer = document.getElementById('composer') as HTMLElement;
const quickRow = document.getElementById('quickRow') as HTMLElement;
const textarea = document.getElementById('question') as HTMLTextAreaElement;
const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
const pinButton = document.getElementById('pinButton') as HTMLButtonElement;
const composerHint = document.getElementById('composerHint') as HTMLElement;

let lastStatus = '';
let lastStatusMarkup = '';

app.addEventListener('click', (event) => {
  const target = event.target as Element;
  const anchor = target.closest('a');
  if (anchor) {
    const href = anchor.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) {
      event.preventDefault();
      post({ type: 'openLink', url: href });
    } else if (href) {
      event.preventDefault();
    }
    return;
  }

  const quick = target.closest<HTMLElement>('[data-quick]');
  if (quick && !quick.hasAttribute('disabled')) {
    const kind = quick.dataset.quick as QuickAction | undefined;
    if (kind) post({ type: 'quick', kind });
    return;
  }

  const button = target.closest<HTMLElement>('[data-action]');
  if (!button || button.hasAttribute('disabled')) return;

  switch (button.dataset.action) {
    case 'pin':
      post({ type: 'pin', value: !state.value.pinned });
      break;
    case 'setup':
      post({ type: 'setup' });
      break;
    case 'openSettings':
      post({ type: 'openSettings' });
      break;
    case 'explain':
      post({ type: 'explain' });
      break;
    case 'retry':
      post({ type: 'retry' });
      break;
    case 'copy':
      post({ type: 'copy' });
      flashCopied(button);
      break;
    case 'openFile':
      post({ type: 'openFile' });
      break;
    case 'repoMap':
      post({ type: 'repoMap' });
      break;
    case 'openRelated': {
      const uri = button.dataset.uri;
      const line = Number(button.dataset.line);
      if (uri && Number.isFinite(line)) post({ type: 'openRelated', uri, line });
      break;
    }
    case 'send':
      sendQuestion();
      break;
    default:
      break;
  }
});

app.addEventListener('change', (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.id === 'autoToggle') {
    post({ type: 'toggleAuto', value: input.checked });
  }
});

app.addEventListener('input', (event) => {
  if (event.target === textarea) {
    autoSize();
    updateSendButton();
  }
});

textarea.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  sendQuestion();
});

window.addEventListener('message', (event: MessageEvent<{ type?: string; state?: CardState }>) => {
  if (event.data?.type !== 'state' || !event.data.state) return;
  state.value = { ...defaultState(), ...event.data.state };
  render();
});

vscode.postMessage({ type: 'ready' });
render();

function render(): void {
  const next = state.value;
  const statusChanged = next.status !== lastStatus;
  const atBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 56;
  const previousTop = content.scrollTop;

  document.body.dataset.status = next.status;
  updateHeader();
  const statusMarkup = renderStatus();
  if (statusMarkup !== lastStatusMarkup) {
    statusLine.innerHTML = statusMarkup;
    lastStatusMarkup = statusMarkup;
  }

  content.innerHTML = renderBody();
  decorateLinks();

  const enteringContent =
    statusChanged &&
    (next.status === 'loading' ||
      next.status === 'empty' ||
      lastStatus === 'empty' ||
      lastStatus === 'setup' ||
      lastStatus === 'idle');
  if (!lastStatus || enteringContent) {
    content.scrollTop = 0;
  } else if (atBottom) {
    content.scrollTop = content.scrollHeight;
  } else {
    content.scrollTop = previousTop;
  }

  updateComposer();
  lastStatus = next.status;
}

function updateHeader(): void {
  const pinned = state.value.pinned;
  pinButton.classList.toggle('active', pinned);
  pinButton.title = pinned ? '取消固定' : '固定这次解释';
  pinButton.setAttribute('aria-pressed', String(pinned));
}

function renderStatus(): string {
  const value = state.value;
  const warning = value.needsSetup ? '<span class="status-warning">未连接</span>' : '';
  const pinned = value.pinned ? '<span class="pin-pill">已固定</span>' : '';
  const untrusted = value.untrusted ? '<span class="status-warning">受限</span>' : '';
  return `
    <span class="status-dot ${escapeHtml(value.status)}"></span>
    <span class="status-provider">${escapeHtml(value.providerLabel)}</span>
    <span class="status-sep">·</span>
    <span class="status-model" title="${escapeHtml(value.model)}">${escapeHtml(value.model)}</span>
    ${warning}${pinned}${untrusted}
    <span class="status-spacer"></span>
    <label class="switch" title="选中代码后自动解释">
      <input id="autoToggle" type="checkbox" ${value.autoExplain ? 'checked' : ''} ${value.untrusted ? 'disabled' : ''} />
      <span class="switch-track"><span class="switch-thumb"></span></span>
      <span class="switch-label">自动</span>
    </label>
  `;
}

function renderBody(): string {
  const value = state.value;
  if (value.status === 'empty') return heroMarkup();
  if (value.status === 'setup') return setupMarkup();

  const context = value.selection ? contextMarkup() : '';
  if (value.status === 'idle') return `${context}${idleMarkup()}`;
  if (value.status === 'error') return `${context}${graphMarkup()}${errorMarkup()}`;
  if (value.status === 'loading') return `${context}${graphMarkup()}${thinkingMarkup()}`;

  const hasGist = Boolean(value.gist);
  const hasDetail = Boolean(value.detail);
  const hasConversation = value.conversation.length > 0;

  if (value.status === 'streaming' && !hasGist && !hasDetail && !hasConversation) {
    return `${context}${graphMarkup()}${thinkingMarkup()}`;
  }

  return [
    context,
    hasGist ? gistMarkup() : '',
    graphMarkup(),
    hasDetail ? detailMarkup() : value.status === 'streaming' ? detailSkeleton() : '',
    hasConversation ? conversationMarkup() : '',
  ].join('');
}

function heroMarkup(): string {
  const value = state.value;
  const cta = value.needsSetup
    ? `<button class="btn btn-primary btn-block" type="button" data-action="setup">连接一个模型</button>
       <p class="fineprint">支持 DeepSeek · OpenAI · Ollama · 任意兼容接口</p>`
    : `<div class="feature-row"><span>一句话</span><span>关键点</span><span>可追问</span></div>
       <div class="shortcut"><span class="kbd">Alt</span><span class="kbd">Q</span><span>手动解释</span></div>`;

  return `
    <section class="hero">
      <div class="hero-mark">${icons.hero}</div>
      <div class="eyebrow">POCKET CODE DICTIONARY</div>
      <h1>选中，就读懂</h1>
      <p class="hero-copy">拖选任意代码，停半秒。<br />一句话解释出现在行尾，完整卡片留在这里。</p>
      ${cta}
      ${value.untrusted ? '<div class="notice">当前工作区未受信任，自动解释已暂停。你可以手动解释。</div>' : ''}
      <div class="version">v${escapeHtml(value.version)} · 不上传遥测</div>
    </section>
  `;
}

function setupMarkup(): string {
  const value = state.value;
  return `
    <section class="state-card setup-card">
      <div class="state-icon accent">${icons.key}</div>
      <div class="eyebrow">ONE MORE STEP</div>
      <h2>连接你的模型</h2>
      <p>SnipSense 不绑定模型。选一个服务，填入 API Key，就能开始读了。</p>
      <div class="provider-pill">
        <span class="provider-name">${escapeHtml(value.providerLabel)}</span>
        <span class="provider-model">${escapeHtml(value.model)}</span>
      </div>
      <button class="btn btn-primary btn-block" type="button" data-action="setup">设置模型与 API Key</button>
      <button class="btn btn-ghost btn-block" type="button" data-action="openSettings">打开高级设置</button>
      <p class="fineprint">Key 保存在本机 VS Code SecretStorage，不写进 settings.json。</p>
      <div class="local-note">${icons.laptop}<span>没有 Key？本地 <strong>Ollama</strong> 也能用，代码不出本机。</span></div>
    </section>
  `;
}

function idleMarkup(): string {
  const value = state.value;
  const title = value.untrusted
    ? '等你手动发话'
    : value.autoExplain
      ? '这段代码等你发话'
      : '自动解释已关闭';
  const copy = value.untrusted
    ? '未受信任的工作区：为保护代码，自动解释暂停了。'
    : value.autoExplain
      ? '停半秒没有自动开始？按 Alt+Q，或点下面。'
      : '已选好代码，按 Alt+Q 解释，或在下面点一下。';
  return `
    <section class="state-card idle-card">
      <div class="state-icon">${icons.command}</div>
      <h2>${title}</h2>
      <p>${copy}</p>
      ${
        value.needsSetup
          ? '<button class="btn btn-primary btn-block" type="button" data-action="setup">先连接模型</button>'
          : '<button class="btn btn-primary btn-block" type="button" data-action="explain">解释这段代码</button>'
      }
      <p class="fineprint">也可以右键选择「解释选中代码」</p>
    </section>
  `;
}

function errorMarkup(): string {
  const value = state.value;
  const primary = value.needsSetup
    ? '<button class="btn btn-primary" type="button" data-action="setup">检查模型配置</button>'
    : `<button class="btn btn-primary" type="button" data-action="retry">${icons.refresh} 重试</button>`;
  return `
    <section class="state-card error-card">
      <div class="state-icon danger">${icons.alert}</div>
      <div class="eyebrow">${value.needsSetup ? 'NOT CONNECTED' : 'DID NOT CATCH THAT'}</div>
      <h2>${value.needsSetup ? '还差一个模型' : '这次没读懂'}</h2>
      <p class="error-copy">${escapeHtml(value.error || '解释失败，请稍后重试。')}</p>
      <div class="button-row">
        ${primary}
        <button class="btn btn-ghost" type="button" data-action="${value.needsSetup ? 'openSettings' : 'setup'}">${value.needsSetup ? '高级设置' : '检查配置'}</button>
      </div>
      <p class="fineprint">可以按 Alt+Q 再试一次。</p>
    </section>
  `;
}

function thinkingMarkup(): string {
  const multiFile = state.value.multiFile;
  return `
    <section class="thinking">
      <div class="thinking-head"><span class="spinner"></span><span>${multiFile ? '正在读懂这段代码和它周围的文件…' : '正在读懂这段代码…'}</span></div>
      <p class="thinking-sub">${multiFile ? '会顺手看 import、调用点和真实用法' : '先给一句话，再补关键点'}</p>
      <div class="shimmer-lines" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
    </section>
  `;
}

function detailSkeleton(): string {
  return `
    <div class="detail-skeleton" aria-hidden="true">
      <div class="shimmer-lines"><span></span><span></span><span></span></div>
    </div>
  `;
}

function contextMarkup(): string {
  const selection = state.value.selection;
  if (!selection) return '';
  const range =
    selection.startLine === selection.endLine
      ? `L${selection.startLine}`
      : `L${selection.startLine}–${selection.endLine}`;
  return `
    <section class="context">
      <div class="context-head">
        <span class="file-mark">&lt;/&gt;</span>
        <span class="file-name" title="${escapeHtml(selection.file)}">${escapeHtml(selection.file)}</span>
        <span class="range">${escapeHtml(range)}</span>
        <span class="lang">${escapeHtml(languageLabel(selection.language))}</span>
        <button class="icon-btn tiny" type="button" data-action="openFile" title="在编辑器中定位" aria-label="在编辑器中定位">${icons.target}</button>
      </div>
      <pre class="code-preview">${escapeHtml(selection.preview)}</pre>
      ${selection.truncated ? '<div class="truncated">选区较长，发送时已从中间截断</div>' : ''}
    </section>
  `;
}

function graphMarkup(): string {
  const graph = state.value.graph;
  if (!graph) return '';
  const dependencies = graph.dependencies;
  const usages = graph.usages;
  if (dependencies.length === 0 && usages.length === 0) return '';

  const counts = [
    dependencies.length ? `${dependencies.length} 个依赖` : '',
    usages.length ? `${usages.length} 处调用` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const dependencyMarkup = dependencies.length
    ? `<div class="related-group">
        <div class="related-label">它依赖</div>
        ${dependencies
          .map(
            (item) => `
          <button class="related-item" type="button" data-action="openRelated" data-uri="${escapeHtml(item.uri)}" data-line="${item.line}">
            <span class="related-file">${escapeHtml(item.file)}</span>
            <span class="related-why">${escapeHtml(item.reason)}</span>
            <span class="related-line">L${item.line}</span>
          </button>`,
          )
          .join('')}
      </div>`
    : '';

  const usageMarkup = usages.length
    ? `<div class="related-group">
        <div class="related-label">谁在用它</div>
        ${usages
          .map(
            (item) => `
          <button class="related-item usage" type="button" data-action="openRelated" data-uri="${escapeHtml(item.uri)}" data-line="${item.line}">
            <span class="related-file">${escapeHtml(item.file)}<span class="related-line">L${item.line}</span></span>
            <span class="related-snippet">${escapeHtml(item.snippet)}</span>
          </button>`,
          )
          .join('')}
      </div>`
    : '';

  return `
    <section class="related">
      <div class="related-head">
        <span class="eyebrow">关联</span>
        <span class="related-count">${escapeHtml(counts)}</span>
      </div>
      ${dependencyMarkup}
      ${usageMarkup}
      ${graph.truncated ? '<div class="related-note">只展示最相关的一部分</div>' : ''}
    </section>
  `;
}

function gistMarkup(): string {
  const value = state.value;
  return `
    <section class="gist-card">
      <div class="gist-head">
        <span class="eyebrow">一句话</span>
        ${value.cached ? '<span class="badge">缓存</span>' : ''}
        <span class="gist-spacer"></span>
        <button class="icon-btn tiny" type="button" data-action="copy" title="复制解释" aria-label="复制解释">${icons.copy}</button>
      </div>
      <p class="gist-text">${escapeHtml(value.gist)}</p>
    </section>
  `;
}

function detailMarkup(): string {
  return `
    <section class="detail-wrap">
      <div class="section-head">
        <span class="eyebrow">关键点</span>
        <button class="mini-btn" type="button" data-action="retry" title="重新解释">${icons.refresh} 重新解释</button>
      </div>
      <div class="markdown detail">${renderMarkdown(state.value.detail)}</div>
    </section>
  `;
}

function conversationMarkup(): string {
  const turns = state.value.conversation;
  return `
    <section class="conversation">
      ${turns
        .map(
          (turn) => `
        <div class="turn">
          <div class="turn-q"><span class="turn-label">你</span><span>${escapeHtml(turn.question)}</span></div>
          <div class="turn-a markdown">
            ${
              turn.pending
                ? '<span class="typing">正在回答<span class="typing-dots">…</span></span>'
                : turn.error
                  ? `<span class="turn-error">${escapeHtml(turn.error)}</span>`
                  : renderMarkdown(turn.answer)
            }
          </div>
        </div>
      `,
        )
        .join('')}
    </section>
  `;
}

function updateComposer(): void {
  const value = state.value;
  const hasExplanation = Boolean(value.gist || value.detail);
  const visible = hasExplanation && (value.status === 'done' || value.status === 'streaming');
  composer.hidden = !visible;

  const canAsk = visible && value.status === 'done';
  textarea.disabled = !canAsk;
  textarea.placeholder = canAsk ? '继续问这段代码…' : '正在回答…';
  quickRow.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.disabled = !canAsk;
  });
  composerHint.textContent = canAsk ? 'Enter 发送 · Shift+Enter 换行' : '正在回答…';
  updateSendButton();
}

function updateSendButton(): void {
  sendButton.disabled = !textarea.value.trim() || textarea.disabled;
}

function sendQuestion(): void {
  const text = textarea.value.trim();
  if (!text || textarea.disabled) return;
  post({ type: 'ask', text });
  textarea.value = '';
  autoSize();
  updateSendButton();
}

function autoSize(): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(96, Math.max(20, textarea.scrollHeight))}px`;
}

function decorateLinks(): void {
  content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noreferrer noopener');
    } else {
      anchor.removeAttribute('href');
    }
  });
}

function renderMarkdown(value: string): string {
  if (!value.trim()) return '';
  const raw = marked.parse(value, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'style',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'link',
      'meta',
      'base',
    ],
    FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'onmouseover'],
  });
}

function flashCopied(button: HTMLElement): void {
  const original = button.innerHTML;
  button.innerHTML = icons.check;
  button.classList.add('copied');
  window.setTimeout(() => {
    button.innerHTML = original;
    button.classList.remove('copied');
  }, 1400);
}

function languageLabel(language: string): string {
  const map: Record<string, string> = {
    typescript: 'TS',
    javascript: 'JS',
    typescriptreact: 'TSX',
    javascriptreact: 'JSX',
    python: 'PY',
    rust: 'RS',
    go: 'GO',
    java: 'JAVA',
    csharp: 'C#',
    cpp: 'C++',
    c: 'C',
    json: 'JSON',
    markdown: 'MD',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    sql: 'SQL',
    shellscript: 'SH',
    yaml: 'YAML',
    plaintext: 'TEXT',
  };
  return map[language] ?? language.slice(0, 6).toUpperCase();
}

function post(message: unknown): void {
  vscode.postMessage(message);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[character] ?? character;
  });
}

function defaultState(): CardState {
  return {
    status: 'empty',
    selection: null,
    gist: '',
    detail: '',
    error: '',
    provider: 'deepseek',
    providerLabel: 'DeepSeek',
    model: 'deepseek-chat',
    autoExplain: true,
    inlineGloss: true,
    pinned: false,
    needsSetup: false,
    cached: false,
    conversation: [],
    graph: null,
    multiFile: true,
    untrusted: false,
    version: '0.4.0',
  };
}
