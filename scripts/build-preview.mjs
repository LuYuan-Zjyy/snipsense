import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const js = fs.readFileSync(path.join(root, 'dist', 'webview.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'dist', 'webview.css'), 'utf8');

const mock = {
  status: 'done',
  selection: {
    file: 'src/hooks/useDebouncedValue.ts',
    language: 'typescript',
    startLine: 12,
    endLine: 21,
    lineCount: 10,
    preview: `const [debounced, setDebounced] = useState(value);

useEffect(() => {
  const timer = setTimeout(
    () => setDebounced(value),
    delay,
  );
  return () => clearTimeout(timer);
}, [value, delay]);`,
    truncated: false,
  },
  gist: '把频繁变化的值延迟 300ms 再同步，避免每次输入都触发请求。',
  detail: `**它解决的问题**

输入框每敲一个字都会更新 \`value\`。如果下游直接发请求，就会产生一串很快被淘汰的请求。

**关键机制**

- \`useState(value)\` 保存上一次真正同步出去的值
- \`useEffect\` 在 \`value\` 变化时重设定时器
- cleanup 会在下一次 effect 前取消旧定时器，所以只有最后一次能落地

**一个边界**

首次渲染也会先返回初始值，稍后才同步；如果初始值必须立即可用，这个 hook 不适合。`,
  error: '',
  provider: 'deepseek',
  providerLabel: 'DeepSeek',
  model: 'deepseek-chat',
  autoExplain: true,
  inlineGloss: true,
  pinned: false,
  needsSetup: false,
  cached: false,
  conversation: [
    {
      question: '为什么 cleanup 能取消旧定时器？',
      answer:
        '因为每次依赖变化时，React 会先执行上一个 effect 的 cleanup，再运行新的 effect。旧定时器在重新计时前就被 `clearTimeout` 掉了。',
      pending: false,
    },
  ],
  graph: {
    dependencies: [
      {
        file: 'src/lib/delay.ts',
        uri: 'file:///workspace/src/lib/delay.ts',
        line: 4,
        symbols: ['delay'],
        reason: '导入了 delay',
      },
    ],
    usages: [
      {
        file: 'src/pages/search.ts',
        uri: 'file:///workspace/src/pages/search.ts',
        line: 42,
        symbol: 'useDebouncedValue',
        snippet: 'const query = useDebouncedValue(input, 300);',
      },
    ],
    truncated: false,
  },
  multiFile: true,
  untrusted: false,
  version: '0.3.0',
};

const variants = {
  done: mock,
  empty: {
    ...mock,
    status: 'empty',
    selection: null,
    gist: '',
    detail: '',
    conversation: [],
    needsSetup: true,
    graph: null,
  },
  setup: {
    ...mock,
    status: 'setup',
    selection: null,
    gist: '',
    detail: '',
    conversation: [],
    needsSetup: true,
    graph: null,
  },
  loading: {
    ...mock,
    status: 'loading',
    gist: '',
    detail: '',
    conversation: [],
  },
  idle: {
    ...mock,
    status: 'idle',
    gist: '',
    detail: '',
    conversation: [],
    autoExplain: false,
    graph: null,
  },
  error: {
    ...mock,
    status: 'error',
    gist: '',
    detail: '',
    conversation: [],
    graph: null,
    error: 'API Key 无效或已过期。请运行「SnipSense: 设置模型与 API Key」检查。',
  },
};

const theme = `
  :root {
    --vscode-sideBar-background: #0b1220;
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
    --vscode-editor-foreground: #dbe7f5;
  }

  html, body { height: 100%; }
  body {
    width: 420px;
    height: 880px;
    margin: 0;
    padding: 14px;
    overflow: hidden;
    background:
      radial-gradient(80% 55% at 20% 0%, rgba(37, 99, 235, 0.16), transparent 70%),
      radial-gradient(60% 40% at 100% 100%, rgba(16, 185, 129, 0.10), transparent 70%),
      #050a12;
  }
  #app {
    width: 392px;
    height: 852px;
    overflow: hidden;
    border: 1px solid rgba(148, 163, 184, 0.16);
    border-radius: 15px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.02) inset;
  }
  #app .app-shell { height: 100%; }
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SnipSense preview</title>
  <style>${theme}</style>
  <style>${css}</style>
</head>
<body>
  <div id="app"></div>
  <script>
    window.__messages = [];
    window.acquireVsCodeApi = () => ({
      postMessage(message) { window.__messages.push(message); },
      getState() { return undefined; },
      setState() {},
    });
  </script>
  <script>${js.replace(/<\/script/gi, '<\\/script')}</script>
  <script>
    const params = new URLSearchParams(location.search);
    const variants = ${JSON.stringify(variants)};
    const selected = params.get('state') || 'done';
    const mockState = variants[selected] || variants.done;
    const width = Number(params.get('w') || 0);
    if (width) {
      document.body.style.width = (width + 28) + 'px';
      document.getElementById('app').style.width = width + 'px';
    }
    setTimeout(() => window.postMessage({ type: 'state', state: mockState }, '*'), 80);
  </script>
</body>
</html>`;

fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'preview.html'), html, 'utf8');
console.log('wrote docs/preview.html');
