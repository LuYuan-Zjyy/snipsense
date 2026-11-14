import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const js = fs.readFileSync(path.join(root, 'dist', 'repoMap.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'dist', 'repoMap.css'), 'utf8');

const files = [
  ['src/index.ts', 'typescript', ['main'], 0, 1, 100],
  ['src/model/vit.ts', 'typescript', ['ViT', 'PatchEmbed'], 1, 3, 96],
  ['src/model/layer.ts', 'typescript', ['PPEmb', 'Block'], 3, 0, 94],
  ['src/data/loader.ts', 'typescript', ['createLoader', 'normalize'], 2, 1, 72],
  ['src/train.ts', 'typescript', ['trainOneEpoch'], 0, 2, 68],
  ['src/eval.ts', 'typescript', ['evaluate'], 0, 1, 54],
  ['src/config.ts', 'typescript', ['loadConfig'], 4, 0, 48],
  ['py/model/vit.py', 'python', ['ViT'], 0, 2, 66],
  ['py/model/layer.py', 'python', ['PPEmb', 'Block'], 2, 0, 62],
  ['py/train.py', 'python', ['train'], 0, 2, 58],
  ['tests/test_vit.py', 'python', ['test_forward'], 0, 1, 34],
  ['scripts/export_onnx.py', 'python', ['export_model'], 0, 1, 30],
];

const mock = {
  rootName: 'vit-playground',
  files: files.map(([file, language, symbols, inDegree, outDegree, score]) => ({
    path: file,
    language,
    symbols,
    imports: [],
    inDegree,
    outDegree,
    score,
    isEntry: file === 'src/index.ts' || file === 'py/train.py',
  })),
  edges: [
    { from: 'src/index.ts', to: 'src/model/vit.ts', symbols: ['ViT'] },
    { from: 'src/index.ts', to: 'src/train.ts', symbols: ['trainOneEpoch'] },
    { from: 'src/train.ts', to: 'src/model/vit.ts', symbols: ['ViT'] },
    { from: 'src/train.ts', to: 'src/data/loader.ts', symbols: ['createLoader'] },
    { from: 'src/model/vit.ts', to: 'src/model/layer.ts', symbols: ['PPEmb', 'Block'] },
    { from: 'src/model/vit.ts', to: 'src/config.ts', symbols: ['loadConfig'] },
    { from: 'src/eval.ts', to: 'src/model/vit.ts', symbols: ['ViT'] },
    { from: 'src/data/loader.ts', to: 'src/config.ts', symbols: ['loadConfig'] },
    { from: 'py/train.py', to: 'py/model/vit.py', symbols: ['ViT'] },
    { from: 'py/train.py', to: 'tests/test_vit.py', symbols: [] },
    { from: 'py/model/vit.py', to: 'py/model/layer.py', symbols: ['PPEmb', 'Block'] },
    { from: 'scripts/export_onnx.py', to: 'py/model/vit.py', symbols: ['ViT'] },
  ],
  entryPoints: ['src/index.ts', 'py/train.py'],
  keyFiles: [
    'src/index.ts',
    'py/train.py',
    'src/model/vit.ts',
    'src/model/layer.ts',
    'py/model/vit.py',
    'py/model/layer.py',
    'src/train.ts',
    'src/data/loader.ts',
  ],
  languages: { typescript: 7, python: 5 },
  scannedFiles: 12,
  truncated: false,
  focus: 'src/model/vit.ts',
  generatedAt: '2026-11-13T15:00:00.000Z',
};

const callGraph = {
  nodes: [
    {
      id: 'vit.py#train',
      name: 'train',
      qualifiedName: 'train',
      file: 'vit.py',
      language: 'python',
      line: 12,
      character: 0,
      kind: 'function',
    },
    {
      id: 'vit.py#ViT.__init__',
      name: '__init__',
      qualifiedName: 'ViT.__init__',
      file: 'vit.py',
      language: 'python',
      line: 4,
      character: 4,
      className: 'ViT',
      kind: 'method',
    },
    {
      id: 'vit.py#ViT.forward',
      name: 'forward',
      qualifiedName: 'ViT.forward',
      file: 'vit.py',
      language: 'python',
      line: 8,
      character: 4,
      className: 'ViT',
      kind: 'method',
    },
    {
      id: 'layer.py#PPEmb.__init__',
      name: '__init__',
      qualifiedName: 'PPEmb.__init__',
      file: 'layer.py',
      language: 'python',
      line: 4,
      character: 4,
      className: 'PPEmb',
      kind: 'method',
    },
    {
      id: 'layer.py#PPEmb.forward',
      name: 'forward',
      qualifiedName: 'PPEmb.forward',
      file: 'layer.py',
      language: 'python',
      line: 8,
      character: 4,
      className: 'PPEmb',
      kind: 'method',
    },
    {
      id: 'layer.py#Block.__init__',
      name: '__init__',
      qualifiedName: 'Block.__init__',
      file: 'layer.py',
      language: 'python',
      line: 12,
      character: 4,
      className: 'Block',
      kind: 'method',
    },
    {
      id: 'layer.py#Block.forward',
      name: 'forward',
      qualifiedName: 'Block.forward',
      file: 'layer.py',
      language: 'python',
      line: 16,
      character: 4,
      className: 'Block',
      kind: 'method',
    },
    {
      id: 'layer.py#PPEmb',
      name: 'PPEmb',
      qualifiedName: 'PPEmb',
      file: 'layer.py',
      language: 'python',
      line: 3,
      character: 0,
      kind: 'class',
    },
  ],
  edges: [
    { from: 'vit.py#train', to: 'vit.py#ViT.__init__', line: 13 },
    { from: 'vit.py#train', to: 'vit.py#ViT.forward', line: 14 },
    { from: 'vit.py#ViT.__init__', to: 'layer.py#PPEmb.__init__', line: 5 },
    { from: 'vit.py#ViT.__init__', to: 'layer.py#Block.__init__', line: 6 },
    { from: 'vit.py#ViT.forward', to: 'layer.py#PPEmb.forward', line: 9 },
    { from: 'vit.py#ViT.forward', to: 'layer.py#Block.forward', line: 10 },
    { from: 'layer.py#Block.__init__', to: 'layer.py#PPEmb.__init__', line: 13 },
  ],
  roots: ['vit.py#train'],
  focus: 'vit.py#train',
  truncated: false,
};

const trace = {
  fileName: 'trace.json',
  totalEvents: 38,
  durationMs: 420,
  threads: ['1:1'],
  truncated: false,
  roots: [
    {
      id: 1,
      name: 'train',
      file: 'train.py',
      line: 10,
      startMs: 0,
      durationMs: 420,
      depth: 0,
      children: [
        {
          id: 2,
          name: 'build_model',
          file: 'vit.py',
          line: 12,
          startMs: 8,
          durationMs: 68,
          depth: 1,
          children: [
            {
              id: 3,
              name: 'ViT.__init__',
              file: 'vit.py',
              line: 4,
              startMs: 12,
              durationMs: 44,
              depth: 2,
              children: [],
            },
            {
              id: 4,
              name: 'PPEmb.__init__',
              file: 'layer.py',
              line: 4,
              startMs: 34,
              durationMs: 18,
              depth: 2,
              children: [],
            },
          ],
        },
        {
          id: 5,
          name: 'train_one_epoch',
          file: 'train.py',
          line: 28,
          startMs: 82,
          durationMs: 286,
          depth: 1,
          children: [
            {
              id: 6,
              name: 'ViT.forward',
              file: 'vit.py',
              line: 8,
              startMs: 96,
              durationMs: 82,
              depth: 2,
              children: [],
            },
            {
              id: 7,
              name: 'PPEmb.forward',
              file: 'layer.py',
              line: 8,
              startMs: 122,
              durationMs: 38,
              depth: 3,
              children: [],
            },
            {
              id: 8,
              name: 'loss.backward',
              file: 'train.py',
              line: 36,
              startMs: 188,
              durationMs: 144,
              depth: 2,
              children: [],
            },
          ],
        },
        {
          id: 9,
          name: 'save_checkpoint',
          file: 'train.py',
          line: 42,
          startMs: 380,
          durationMs: 30,
          depth: 1,
          children: [],
        },
      ],
    },
  ],
  slowest: [
    {
      id: 1,
      name: 'train',
      file: 'train.py',
      line: 10,
      startMs: 0,
      durationMs: 420,
      depth: 0,
      children: [],
    },
    {
      id: 5,
      name: 'train_one_epoch',
      file: 'train.py',
      line: 28,
      startMs: 82,
      durationMs: 286,
      depth: 1,
      children: [],
    },
    {
      id: 8,
      name: 'loss.backward',
      file: 'train.py',
      line: 36,
      startMs: 188,
      durationMs: 144,
      depth: 2,
      children: [],
    },
  ],
};

const guide = `# 这个仓库在做什么

一个最小可跑的 ViT 实验仓：TypeScript 和 Python 各有一份模型实现，训练入口分别从 \`src/index.ts\` 和 \`py/train.py\` 开始。

## 先读这些文件

- \`src/index.ts\` — 总入口，先看它如何组装训练流程
- \`src/model/vit.ts\` — 核心模型，理解 patch 与 block 的连接
- \`src/model/layer.ts\` — \`PPEmb\` / \`Block\` 的具体实现
- \`src/train.ts\` — 一个 epoch 的训练循环
- \`py/train.py\` — Python 侧对照入口

## 一条核心调用链

\`src/index.ts\` -> \`trainOneEpoch\` -> \`ViT.forward\` -> \`PPEmb\` -> \`Block\`

入口创建模型与数据加载器，\`trainOneEpoch\` 驱动前向/反向；\`ViT\` 先把图像切成 patch，再经过 \`PPEmb\` 和堆叠的 \`Block\` 输出分类 logits。

## 建议的第一个小任务

给 \`PPEmb\` 加一个输入尺寸断言，并补一个 \`tests/test_vit.py\` 的 shape 测试；风险低，又能验证你对 patch 流的理解。

## 还不确定的地方

地图没有覆盖配置文件的具体取值、预训练权重来源，以及 ONNX 导出脚本是否仍在 CI 中使用。`;

const theme = `
  :root {
    --vscode-editor-background: #0b1220;
    --vscode-sideBar-background: #0f172a;
    --vscode-foreground: #e6edf7;
    --vscode-descriptionForeground: #91a4bd;
    --vscode-disabledForeground: #5d6d82;
    --vscode-panel-border: rgba(148, 163, 184, 0.14);
    --vscode-editorWidget-background: #0f1a2c;
    --vscode-list-hoverBackground: rgba(148, 163, 184, 0.08);
    --vscode-textCodeBlock-background: rgba(2, 6, 23, 0.5);
    --vscode-textLink-foreground: #7dd3fc;
    --vscode-charts-green: #6ee7b7;
    --vscode-charts-yellow: #fbbf24;
    --vscode-errorForeground: #f87171;
    --vscode-button-background: #2563eb;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #1d4ed8;
    --vscode-focusBorder: #60a5fa;
    --vscode-font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    --vscode-editor-font-family: "Cascadia Code", Consolas, "Microsoft YaHei", monospace;
  }
  html, body { height: 100%; }
  body {
    margin: 0;
    padding: 14px;
    overflow: hidden;
    background:
      radial-gradient(80% 55% at 20% 0%, rgba(37, 99, 235, 0.16), transparent 70%),
      radial-gradient(60% 40% at 100% 100%, rgba(16, 185, 129, 0.10), transparent 70%),
      #050a12;
  }
  #app {
    height: calc(100vh - 28px);
    overflow: hidden;
    border: 1px solid rgba(148, 163, 184, 0.16);
    border-radius: 15px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
  }
  #app .rm-shell { height: 100%; }
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SnipSense repo map preview</title>
  <style>${theme}</style>
  <style>${css}</style>
</head>
<body>
  <div id="app"></div>
  <script>
    window.acquireVsCodeApi = () => ({
      postMessage(message) { window.__messages.push(message); },
      getState() { return undefined; },
      setState() {},
    });
    window.__messages = [];
  </script>
  <script>${js.replace(/<\/script/gi, '<\\/script')}</script>
  <script>
    const map = ${JSON.stringify(mock)};
    const guide = ${JSON.stringify(guide)};
    const callGraph = ${JSON.stringify(callGraph)};
    const trace = ${JSON.stringify(trace)};
    const tab = new URLSearchParams(location.search).get('tab') || 'map';
    setTimeout(() => {
      window.postMessage({ type: 'map', map }, '*');
      if (tab === 'call') {
        window.postMessage({ type: 'tab', tab: 'call' }, '*');
        window.postMessage({ type: 'callGraph', graph: callGraph }, '*');
        return;
      }
      if (tab === 'trace') {
        window.postMessage({ type: 'tab', tab: 'trace' }, '*');
        window.postMessage({ type: 'trace', model: trace }, '*');
        return;
      }
      window.postMessage({ type: 'guideStart' }, '*');
      const step = Math.ceil(guide.length / 18);
      for (let i = 0; i < guide.length; i += step) {
        window.postMessage({ type: 'guideChunk', chunk: guide.slice(i, i + step) }, '*');
      }
      window.postMessage({ type: 'guideDone' }, '*');
    }, 120);
  </script>
</body>
</html>`;

fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'repo-map-preview.html'), html, 'utf8');
console.log('wrote docs/repo-map-preview.html');
