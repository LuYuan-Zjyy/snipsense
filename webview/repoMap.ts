import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { CallGraph, CallNode } from '../src/core/call-graph';
import type { RepoMap, RepoMapFile } from '../src/core/repo-map';
import type { TraceModel, TraceNode } from '../src/core/trace';
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
let activeTab: 'map' | 'call' | 'trace' = 'map';
let callGraph: CallGraph | null = null;
let callLoading = false;
let callError = '';
let callRoot = '';
let trace: TraceModel | null = null;
let traceLoading = false;
let traceError = '';

marked.setOptions({ gfm: true, breaks: true });

app.innerHTML = `
  <div class="rm-shell">
    <header class="rm-topbar">
      <div class="rm-brand">
        <span class="rm-logo">${icons.map}</span>
        <div class="rm-brand-copy">
          <div class="rm-title">SnipSense <span id="viewTitle">仓库地图</span></div>
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
    <nav class="rm-tabs" aria-label="工作流层级">
      <button type="button" class="rm-tab active" data-tab="map">${icons.map}<span>仓库地图</span><small>结构</small></button>
      <button type="button" class="rm-tab" data-tab="call">${icons.call}<span>调用链</span><small>静态</small></button>
      <button type="button" class="rm-tab" data-tab="trace">${icons.trace}<span>运行轨迹</span><small>真实</small></button>
    </nav>
    <main class="rm-layout rm-view active" id="view-map">
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
    <section class="rm-view rm-call-view" id="view-call">
      <div class="rm-view-head">
        <div>
          <h2>静态调用链</h2>
          <p>从入口或当前函数出发，沿着真实定义解析跨文件调用。它回答“可能调用谁”，不包含运行时分支。</p>
        </div>
        <div class="rm-view-actions">
          <select id="callRoot" class="rm-select" aria-label="选择调用链根节点"></select>
          <button class="rm-btn" type="button" data-action="buildCall">${icons.refresh}<span>重新构建</span></button>
        </div>
      </div>
      <div class="rm-call-body" id="callBody"></div>
    </section>
    <section class="rm-view rm-trace-view" id="view-trace">
      <div class="rm-view-head">
        <div>
          <h2>真实运行轨迹</h2>
          <p>导入 VizTracer 或 PyTorch Profiler 生成的 Chrome trace。显示实际调用、嵌套关系和耗时。</p>
        </div>
        <div class="rm-view-actions">
          <button class="rm-btn rm-primary" type="button" data-action="importTrace">${icons.trace}<span>导入 trace.json</span></button>
        </div>
      </div>
      <div class="rm-trace-body" id="traceBody"></div>
    </section>
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
const callBodyEl = document.getElementById('callBody') as HTMLElement;
const traceBodyEl = document.getElementById('traceBody') as HTMLElement;
const callRootEl = document.getElementById('callRoot') as HTMLSelectElement;
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.rm-tab')];
const shellEl = document.querySelector<HTMLElement>('.rm-shell');
const viewTitleEl = document.getElementById('viewTitle') as HTMLElement;

app.addEventListener('click', (event) => {
  const target = event.target as Element;
  const tab = target.closest<HTMLElement>('[data-tab]');
  if (tab?.dataset.tab === 'map' || tab?.dataset.tab === 'call' || tab?.dataset.tab === 'trace') {
    setActiveTab(tab.dataset.tab, true);
    return;
  }

  const node = target.closest<HTMLElement>('[data-path]');
  if (node?.dataset.path) {
    post({
      type: 'openFile',
      path: node.dataset.path,
      line: node.dataset.line ? Number(node.dataset.line) : undefined,
    });
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
    case 'buildCall':
      post({ type: 'buildCallGraph' });
      break;
    case 'importTrace':
      post({ type: 'importTrace' });
      break;
    default:
      break;
  }
});

callRootEl.addEventListener('change', () => {
  callRoot = callRootEl.value;
  renderCall();
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
    case 'tab':
      if (message.tab === 'map' || message.tab === 'call' || message.tab === 'trace') {
        setActiveTab(message.tab, false);
      }
      break;
    case 'callLoading':
      callLoading = true;
      callError = '';
      renderCall();
      break;
    case 'callGraph':
      callGraph = message.graph as CallGraph;
      callLoading = false;
      callError = '';
      callRoot = callGraph.focus ?? callGraph.roots[0] ?? '';
      renderCall();
      break;
    case 'callError':
      callLoading = false;
      callError = typeof message.message === 'string' ? message.message : '调用链构建失败';
      renderCall();
      break;
    case 'traceLoading':
      traceLoading = true;
      traceError = '';
      renderTrace();
      break;
    case 'trace':
      trace = message.model as TraceModel;
      traceLoading = false;
      traceError = '';
      renderTrace();
      break;
    case 'traceError':
      traceLoading = false;
      traceError = typeof message.message === 'string' ? message.message : '运行轨迹导入失败';
      renderTrace();
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
  renderTabs();
  renderCall();
  renderTrace();
}

function setActiveTab(tab: 'map' | 'call' | 'trace', notify: boolean): void {
  activeTab = tab;
  renderTabs();
  if (notify) post({ type: 'tab', tab });
}

function renderTabs(): void {
  for (const tab of tabs) {
    tab.classList.toggle('active', tab.dataset.tab === activeTab);
  }
  for (const name of ['map', 'call', 'trace']) {
    document.getElementById(`view-${name}`)?.classList.toggle('active', name === activeTab);
  }
  viewTitleEl.textContent =
    activeTab === 'map' ? '仓库地图' : activeTab === 'call' ? '调用链' : '运行轨迹';
  shellEl?.classList.toggle('tab-map', activeTab === 'map');
  shellEl?.classList.toggle('tab-call', activeTab === 'call');
  shellEl?.classList.toggle('tab-trace', activeTab === 'trace');
}

function renderCall(): void {
  const options = callGraph
    ? [...new Set([callGraph.focus, ...callGraph.roots].filter(Boolean))]
    : [];
  callRootEl.innerHTML = options
    .map((id) => {
      const node = callGraph?.nodes.find((candidate) => candidate.id === id);
      return node
        ? `<option value="${escapeHtml(node.id)}" ${node.id === callRoot ? 'selected' : ''}>${escapeHtml(node.qualifiedName)} · ${escapeHtml(node.file)}:${node.line}</option>`
        : '';
    })
    .join('');

  if (callLoading) {
    callBodyEl.innerHTML = '<div class="rm-empty">正在解析函数定义和调用关系…</div>';
    return;
  }
  if (callError) {
    callBodyEl.innerHTML = `<div class="rm-error">${escapeHtml(callError)}</div>`;
    return;
  }
  if (!callGraph) {
    callBodyEl.innerHTML = `
      <div class="rm-empty rm-call-empty">
        <p>调用链会解析函数／方法定义、import 和 <code>self.attr.method()</code> 的类型，生成可点击的静态调用树。</p>
        <button class="rm-btn rm-primary" type="button" data-action="buildCall">构建调用链</button>
      </div>`;
    return;
  }

  if (!callRoot || !callGraph.nodes.some((node) => node.id === callRoot)) {
    callRoot = callGraph.focus ?? callGraph.roots[0] ?? '';
  }

  const byId = new Map(callGraph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, Array<{ to: string; line: number }>>();
  for (const edge of callGraph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push({ to: edge.to, line: edge.line });
    outgoing.set(edge.from, list);
  }

  const rows: string[] = [];
  const stack = new Set<string>();
  let count = 0;

  const walk = (id: string, depth: number): void => {
    if (count >= 180 || depth > 6) return;
    const node = byId.get(id);
    if (!node) return;
    count += 1;
    const cyclic = stack.has(id);
    rows.push(callRowMarkup(node, depth, cyclic));
    if (cyclic) return;

    stack.add(id);
    for (const edge of outgoing.get(id) ?? []) walk(edge.to, depth + 1);
    stack.delete(id);
  };

  walk(callRoot, 0);
  const root = byId.get(callRoot);
  callBodyEl.innerHTML = `
    <div class="rm-call-summary">
      <span class="rm-pill">${callGraph.nodes.length} 个函数</span>
      <span class="rm-pill">${callGraph.edges.length} 条调用</span>
      <span class="rm-pill">${count} 行展开</span>
      <span class="rm-faint">静态推演 · 最多 6 层 · 点击跳源码</span>
    </div>
    <div class="rm-call-list">${rows.join('')}</div>
    ${root ? `<div class="rm-call-note">根节点：<code>${escapeHtml(root.qualifiedName)}</code> · ${escapeHtml(root.file)}:${root.line}</div>` : ''}
  `;
}

function callRowMarkup(node: CallNode, depth: number, cyclic: boolean): string {
  return `
    <button class="rm-call-row kind-${node.kind}" type="button" data-path="${escapeHtml(node.file)}" data-line="${node.line}" style="--depth:${depth}">
      <span class="rm-call-branch">${depth === 0 ? '●' : '└'}</span>
      <span class="rm-call-name">${escapeHtml(node.qualifiedName)}</span>
      <span class="rm-call-file">${escapeHtml(node.file)}:${node.line}</span>
      ${cyclic ? '<span class="rm-call-cycle">↻ 循环</span>' : ''}
    </button>`;
}

function renderTrace(): void {
  if (traceLoading) {
    traceBodyEl.innerHTML = '<div class="rm-empty">正在解析 trace…</div>';
    return;
  }
  if (traceError) {
    traceBodyEl.innerHTML = `<div class="rm-error">${escapeHtml(traceError)}</div>`;
    return;
  }
  if (!trace) {
    traceBodyEl.innerHTML = `
      <div class="rm-empty rm-trace-empty">
        <p>先生成一份 Chrome trace，再导入这里。VizTracer 适合 Python/PyTorch：</p>
        <pre><code>pip install viztracer
viztracer -o trace.json train.py</code></pre>
        <p>PyTorch Profiler 导出的 <code>chrome_trace.json</code> 也可以直接导入。</p>
        <button class="rm-btn rm-primary" type="button" data-action="importTrace">导入 trace.json</button>
      </div>`;
    return;
  }

  const rows: string[] = [];
  let count = 0;
  const total = Math.max(trace.durationMs, 0.001);
  const walk = (nodes: TraceNode[], depth: number): void => {
    for (const node of nodes) {
      if (count >= 500) return;
      count += 1;
      const width = Math.min(100, Math.max(0.8, (node.durationMs / total) * 100));
      const offset = Math.min(99, Math.max(0, (node.startMs / total) * 100));
      rows.push(`
        <button class="rm-trace-row" type="button" ${node.file ? `data-path="${escapeHtml(node.file)}" data-line="${node.line ?? 1}"` : ''} style="--depth:${Math.min(depth, 10)}">
          <span class="rm-trace-name">${escapeHtml(node.name)}</span>
          <span class="rm-trace-bar"><i style="left:${offset.toFixed(1)}%;width:${width.toFixed(1)}%"></i></span>
          <span class="rm-trace-time">${formatMs(node.durationMs)}</span>
          <span class="rm-trace-file">${node.file ? `${escapeHtml(basename(node.file))}:${node.line ?? '?'}` : ''}</span>
        </button>`);
      walk(node.children, depth + 1);
    }
  };
  walk(trace.roots, 0);

  const slowest = trace.slowest
    .slice(0, 5)
    .map(
      (node) => `
      <button class="rm-slow-row" type="button" ${node.file ? `data-path="${escapeHtml(node.file)}" data-line="${node.line ?? 1}"` : ''}>
        <span>${escapeHtml(node.name)}</span><b>${formatMs(node.durationMs)}</b>
      </button>`,
    )
    .join('');

  traceBodyEl.innerHTML = `
    <div class="rm-call-summary">
      <span class="rm-pill">${trace.totalEvents} 个事件</span>
      <span class="rm-pill">${formatMs(trace.durationMs)}</span>
      <span class="rm-pill">${trace.threads.length} 个线程</span>
      <span class="rm-faint">${escapeHtml(trace.fileName)}${trace.truncated ? ' · 已截断' : ''}</span>
    </div>
    <div class="rm-trace-layout">
      <div class="rm-trace-timeline">${rows.join('') || '<div class="rm-empty">没有可显示的事件。</div>'}</div>
      <aside class="rm-slowest">
        <h3>最慢的调用</h3>
        ${slowest || '<span class="rm-faint">没有数据</span>'}
      </aside>
    </div>`;
}

function formatMs(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 1) return `${value.toFixed(1)} ms`;
  return `${(value * 1000).toFixed(0)} µs`;
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
