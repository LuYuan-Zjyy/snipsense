import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { RepoMap, RepoMapFile } from '../src/core/repo-map';
import './repoMap.css';
import { icons } from './mapIcons';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLDivElement;

let map: RepoMap | null = null;
let scanning = true;
let error = '';
let guide = '';
let guideStatus: 'idle' | 'streaming' | 'done' | 'error' = 'idle';
let guideError = '';
let guideNeedsSetup = false;
let graphKey = '';

marked.setOptions({ gfm: true, breaks: true });

app.innerHTML = `
  <div class="rm-shell">
    <header class="rm-topbar">
      <div class="rm-brand">
        <span class="rm-logo">${icons.map}</span>
        <div class="rm-brand-copy">
          <div class="rm-title">SnipSense <span>仓库地图</span></div>
          <div class="rm-root" id="root">读取仓库中…</div>
        </div>
      </div>
      <div class="rm-actions">
        <button class="rm-btn" type="button" data-action="refresh" title="重新扫描">${icons.refresh}<span>重新扫描</span></button>
        <button class="rm-btn" type="button" data-action="copy" title="复制地图 Markdown">${icons.copy}<span id="copyLabel">复制地图</span></button>
        <button class="rm-btn rm-primary" type="button" data-action="guide" title="生成阅读路线">${icons.spark}<span>生成 AI 导读</span></button>
      </div>
    </header>
    <div class="rm-summary" id="summary"></div>
    <main class="rm-layout">
      <aside class="rm-side">
        <div class="rm-panel-head">
          <span>阅读路线</span>
          <button class="rm-mini" type="button" data-action="focus" title="以当前编辑器文件重新排序">当前文件</button>
        </div>
        <div class="rm-route" id="route"></div>
      </aside>
      <section class="rm-graph-wrap">
        <div class="rm-panel-head">
          <span>依赖地图</span>
          <span class="rm-legend" id="legend"></span>
        </div>
        <div class="rm-graph" id="graph"></div>
      </section>
      <aside class="rm-guide">
        <div class="rm-panel-head">
          <span>AI 导读</span>
          <span class="rm-guide-status" id="guideStatus"></span>
        </div>
        <div class="rm-guide-body" id="guideBody"></div>
      </aside>
    </main>
  </div>
`;

const rootEl = document.getElementById('root') as HTMLElement;
const summaryEl = document.getElementById('summary') as HTMLElement;
const routeEl = document.getElementById('route') as HTMLElement;
const graphEl = document.getElementById('graph') as HTMLElement;
const legendEl = document.getElementById('legend') as HTMLElement;
const guideBodyEl = document.getElementById('guideBody') as HTMLElement;
const guideStatusEl = document.getElementById('guideStatus') as HTMLElement;
const copyLabel = document.getElementById('copyLabel') as HTMLElement;

app.addEventListener('click', (event) => {
  const target = event.target as Element;
  const node = target.closest<HTMLElement>('[data-path]');
  if (node?.dataset.path) {
    post({ type: 'openFile', path: node.dataset.path });
    return;
  }

  const button = target.closest<HTMLElement>('[data-action]');
  if (!button) return;
  switch (button.dataset.action) {
    case 'refresh':
      post({ type: 'refresh' });
      break;
    case 'focus':
      post({ type: 'focus' });
      break;
    case 'copy':
      post({ type: 'copy' });
      break;
    case 'guide':
      post({ type: 'guide' });
      break;
    case 'setup':
      post({ type: 'setup' });
      break;
    default:
      break;
  }
});

window.addEventListener('message', (event: MessageEvent<Record<string, unknown>>) => {
  const message = event.data;
  switch (message.type) {
    case 'map':
      map = message.map as RepoMap;
      scanning = false;
      error = '';
      renderAll();
      break;
    case 'scanning':
      scanning = true;
      error = '';
      renderAll();
      break;
    case 'error':
      scanning = false;
      error = typeof message.message === 'string' ? message.message : '扫描失败';
      renderAll();
      break;
    case 'guideStart':
      guide = '';
      guideStatus = 'streaming';
      guideError = '';
      guideNeedsSetup = false;
      renderGuide();
      break;
    case 'guideChunk':
      if (typeof message.chunk === 'string') {
        guide += message.chunk;
        renderGuide();
      }
      break;
    case 'guideDone':
      guideStatus = 'done';
      renderGuide();
      break;
    case 'guideError':
      guideStatus = 'error';
      guideError = typeof message.message === 'string' ? message.message : '生成失败';
      guideNeedsSetup = Boolean(message.setup);
      renderGuide();
      break;
    case 'copied':
      copyLabel.textContent = '已复制';
      window.setTimeout(() => {
        copyLabel.textContent = '复制地图';
      }, 1400);
      break;
    default:
      break;
  }
});

vscode.postMessage({ type: 'ready' });
renderAll();

function renderAll(): void {
  rootEl.textContent = map
    ? `${map.rootName}${map.focus ? ` · 关注 ${basename(map.focus)}` : ''}`
    : '读取仓库中…';
  summaryEl.innerHTML = summaryMarkup();
  routeEl.innerHTML = routeMarkup();
  legendEl.innerHTML = legendMarkup();
  if (map) {
    const key = `${map.generatedAt}:${map.focus ?? ''}:${map.scannedFiles}`;
    if (key !== graphKey) {
      graphKey = key;
      renderGraph(map);
    }
  } else {
    graphEl.innerHTML = '<div class="rm-empty">正在扫描工作区…</div>';
  }
  renderGuide();
}

function summaryMarkup(): string {
  if (error) return `<div class="rm-error">${escapeHtml(error)}</div>`;
  if (!map) return '<div class="rm-skeleton"></div>';
  const languages = Object.entries(map.languages)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([name, count]) => `${escapeHtml(languageLabel(name))} ${count}`)
    .join(' · ');
  return `
    <span class="rm-pill">${map.scannedFiles} 个文件</span>
    <span class="rm-pill">${map.edges.length} 条依赖</span>
    <span class="rm-pill">${map.entryPoints.length} 个入口</span>
    <span class="rm-langs">${languages}</span>
    ${map.truncated ? '<span class="rm-warn">地图已截断</span>' : ''}
    ${scanning ? '<span class="rm-scanning">正在重新扫描…</span>' : ''}
  `;
}

function routeMarkup(): string {
  if (!map) return '<div class="rm-empty">扫描完成后，这里会出现推荐阅读顺序。</div>';
  const entrySet = new Set(map.entryPoints);
  const items: RepoMapFile[] = [];
  for (const path of map.entryPoints) {
    const file = map.files.find((candidate) => candidate.path === path);
    if (file) items.push(file);
  }
  for (const path of map.keyFiles) {
    if (entrySet.has(path)) continue;
    const file = map.files.find((candidate) => candidate.path === path);
    if (file) items.push(file);
  }

  return items
    .slice(0, 12)
    .map(
      (file, index) => `
    <button class="rm-route-item ${file.isEntry ? 'entry' : ''}" type="button" data-path="${escapeHtml(file.path)}">
      <span class="rm-step">${index + 1}</span>
      <span class="rm-route-main">
        <span class="rm-file">${escapeHtml(file.path)}</span>
        <span class="rm-meta">
          ${file.isEntry ? '<b class="rm-entry">入口</b>' : ''}
          <span>${escapeHtml(languageLabel(file.language))}</span>
          <span>被依赖 ${file.inDegree}</span>
          <span>依赖 ${file.outDegree}</span>
        </span>
        ${
          file.symbols.length
            ? `<span class="rm-symbols">${escapeHtml(file.symbols.slice(0, 4).join(' · '))}</span>`
            : ''
        }
      </span>
    </button>`,
    )
    .join('');
}

function renderGraph(current: RepoMap): void {
  const display = selectGraphFiles(current);
  if (display.length === 0) {
    graphEl.innerHTML = '<div class="rm-empty">没有找到可显示的代码文件。</div>';
    return;
  }

  const nodes = display.map((file, index) => {
    const angle = index * 2.399963;
    const radius = 110 + Math.sqrt(index) * 42;
    return {
      file,
      x: 500 + Math.cos(angle) * radius,
      y: 300 + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      r: 7 + Math.min(13, Math.sqrt(file.inDegree + 1) * 3.4),
    };
  });
  const byPath = new Map(nodes.map((node) => [node.file.path, node]));
  const edges = current.edges.filter((edge) => byPath.has(edge.from) && byPath.has(edge.to));

  for (let iteration = 0; iteration < 130; iteration += 1) {
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const a = nodes[left]!;
        const b = nodes[right]!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.max(8, Math.hypot(dx, dy));
        const force = 2600 / (distance * distance);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    for (const edge of edges) {
      const a = byPath.get(edge.from)!;
      const b = byPath.get(edge.to)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 135) * 0.006;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const node of nodes) {
      node.vx += (500 - node.x) * 0.0018;
      node.vy += (300 - node.y) * 0.0022;
      node.x = clamp(node.x + node.vx, 35, 965);
      node.y = clamp(node.y + node.vy, 30, 570);
      node.vx *= 0.72;
      node.vy *= 0.72;
    }
  }

  const edgeMarkup = edges
    .map((edge) => {
      const a = byPath.get(edge.from)!;
      const b = byPath.get(edge.to)!;
      const highlight = edge.from === current.focus || edge.to === current.focus;
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" class="rm-edge ${highlight ? 'focus' : ''}" />`;
    })
    .join('');

  const nodeMarkup = nodes
    .map((node) => {
      const focused = node.file.path === current.focus;
      return `<g class="rm-node ${focused ? 'focus' : ''}" data-path="${escapeHtml(node.file.path)}" transform="translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})">
        <circle r="${node.r.toFixed(1)}" fill="${languageColor(node.file.language)}" />
        <text y="${(node.r + 13).toFixed(1)}" text-anchor="middle">${escapeHtml(basename(node.file.path))}</text>
        <title>${escapeHtml(node.file.path)}\n${escapeHtml(node.file.symbols.slice(0, 6).join(', '))}</title>
      </g>`;
    })
    .join('');

  graphEl.innerHTML = `<svg viewBox="0 0 1000 600" role="img" aria-label="仓库依赖图">
    <g>${edgeMarkup}</g>
    <g>${nodeMarkup}</g>
  </svg>`;
}

function selectGraphFiles(current: RepoMap): RepoMapFile[] {
  const selected = new Map<string, RepoMapFile>();
  const add = (file: RepoMapFile | undefined): void => {
    if (!file || selected.size >= 60) return;
    selected.set(file.path, file);
  };
  for (const path of current.entryPoints) add(current.files.find((file) => file.path === path));
  for (const path of current.keyFiles) add(current.files.find((file) => file.path === path));
  for (const edge of current.edges) {
    add(current.files.find((file) => file.path === edge.from));
    add(current.files.find((file) => file.path === edge.to));
    if (selected.size >= 60) break;
  }
  for (const file of current.files) add(file);
  return [...selected.values()];
}

function legendMarkup(): string {
  if (!map) return '';
  const seen = new Set<string>();
  return Object.entries(map.languages)
    .sort((left, right) => right[1] - left[1])
    .filter(([language]) => {
      if (seen.has(language)) return false;
      seen.add(language);
      return true;
    })
    .slice(0, 5)
    .map(
      ([language]) =>
        `<span><i style="background:${languageColor(language)}"></i>${escapeHtml(languageLabel(language))}</span>`,
    )
    .join('');
}

function renderGuide(): void {
  guideStatusEl.textContent =
    guideStatus === 'streaming'
      ? '生成中…'
      : guideStatus === 'done'
        ? '完成'
        : guideStatus === 'error'
          ? '失败'
          : '';

  if (guideStatus === 'streaming' || guideStatus === 'done') {
    guideBodyEl.innerHTML = `<div class="rm-markdown">${markdown(guide)}${guideStatus === 'streaming' ? '<span class="rm-caret"></span>' : ''}</div>`;
    if (guideStatus === 'streaming') guideBodyEl.scrollTop = guideBodyEl.scrollHeight;
    return;
  }

  if (guideStatus === 'error') {
    guideBodyEl.innerHTML = `
      <div class="rm-guide-error">${escapeHtml(guideError)}</div>
      ${guideNeedsSetup ? '<button class="rm-btn rm-primary" type="button" data-action="setup">设置模型</button>' : '<button class="rm-btn" type="button" data-action="guide">重试</button>'}
    `;
    return;
  }

  guideBodyEl.innerHTML = `
    <div class="rm-guide-empty">
      <div class="rm-guide-mark">${icons.spark}</div>
      <h2>先看地图，再读代码</h2>
      <p>用这份依赖地图生成一条 30–60 分钟的阅读路线：先看哪些文件、核心调用链怎么走、可以拿什么小任务练手。</p>
      <p class="rm-fineprint">只发送文件路径、符号和依赖边，不发送完整源码。会消耗一次模型调用。</p>
      <button class="rm-btn rm-primary" type="button" data-action="guide">生成 AI 导读</button>
    </div>
  `;
}

function markdown(value: string): string {
  if (!value.trim()) return '';
  const raw = marked.parse(value, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea'],
    FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
  });
}

function languageColor(language: string): string {
  const normalized = language.toLowerCase();
  if (normalized.includes('typescript')) return '#60a5fa';
  if (normalized.includes('javascript')) return '#facc15';
  if (normalized === 'python') return '#4ade80';
  if (normalized === 'java' || normalized === 'kotlin') return '#fb923c';
  if (normalized === 'go') return '#22d3ee';
  if (normalized === 'rust') return '#f87171';
  if (normalized === 'vue' || normalized === 'svelte') return '#34d399';
  return '#94a3b8';
}

function languageLabel(language: string): string {
  const map: Record<string, string> = {
    typescript: 'TS',
    typescriptreact: 'TSX',
    javascript: 'JS',
    javascriptreact: 'JSX',
    python: 'PY',
    java: 'JAVA',
    kotlin: 'KT',
    go: 'GO',
    rust: 'RS',
    vue: 'VUE',
    svelte: 'SVELTE',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
  };
  return map[language] ?? language.slice(0, 5).toUpperCase();
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function post(message: unknown): void {
  vscode.postMessage(message);
}
