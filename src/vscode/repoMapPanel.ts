import * as vscode from 'vscode';
import { LlmError, streamChat } from '../core/client';
import { PROVIDERS, normalizeEndpoint, resolveApiBase, resolveModel } from '../core/endpoint';
import { buildCallGraph, type CallGraph } from '../core/call-graph';
import { buildRepoGuideMessages, buildRepoMapSummary } from '../core/repo-map';
import { isAbortError } from '../core/text';
import { parseChromeTrace, type TraceModel } from '../core/trace';
import { getApiKey, readSettings } from './config';
import { scanWorkspaceRepoMap, type RepoScanResult } from './repo-map';

type PanelTab = 'map' | 'call' | 'trace';

type PanelMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'copy' }
  | { type: 'guide' }
  | { type: 'setup' }
  | { type: 'focus' }
  | { type: 'tab'; tab?: unknown }
  | { type: 'buildCallGraph' }
  | { type: 'importTrace' }
  | { type: 'openFile'; path?: unknown; line?: unknown };

export class RepoMapPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private scan: RepoScanResult | undefined;
  private scanError = '';
  private activeTab: PanelTab = 'map';
  private callGraph: CallGraph | undefined;
  private trace: TraceModel | undefined;
  private callLoading = false;
  private traceLoading = false;
  private abort: AbortController | undefined;
  private scanGeneration = 0;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

  async show(focusUri?: vscode.Uri, tab: PanelTab = 'map'): Promise<void> {
    if (this.disposed) return;
    this.activeTab = tab;

    if (this.panel) {
      this.panel.reveal(undefined, true);
      this.post({ type: 'tab', tab: this.activeTab });
      if (tab === 'trace') return;
      await this.scanWorkspace(focusUri);
      if (tab === 'call') await this.ensureCallGraph();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'snipsense.repoMap',
      'SnipSense · 代码工作流',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'dist'),
          vscode.Uri.joinPath(this.extensionUri, 'media'),
        ],
      },
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((message: PanelMessage) => this.onMessage(message));
    panel.onDidDispose(() => {
      this.abort?.abort();
      this.panel = undefined;
    });

    await this.scanWorkspace(focusUri);
    if (tab === 'call') await this.ensureCallGraph();
  }

  async importTraceFile(): Promise<void> {
    await this.show(undefined, 'trace');
    await this.importTrace();
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.panel?.dispose();
    this.panel = undefined;
  }

  private onMessage(message: PanelMessage): void {
    switch (message.type) {
      case 'ready':
        this.post({ type: 'tab', tab: this.activeTab });
        if (this.callGraph) this.post({ type: 'callGraph', graph: this.callGraph });
        if (this.trace) this.post({ type: 'trace', model: this.trace });
        if (this.scanError) this.post({ type: 'error', message: this.scanError });
        else if (this.scan) this.post({ type: 'map', map: this.scan.map });
        else this.post({ type: 'scanning' });
        break;
      case 'tab':
        if (message.tab === 'map' || message.tab === 'call' || message.tab === 'trace') {
          this.activeTab = message.tab;
          this.post({ type: 'tab', tab: this.activeTab });
          if (this.activeTab === 'call') void this.ensureCallGraph();
        }
        break;
      case 'buildCallGraph':
        void this.ensureCallGraph(true);
        break;
      case 'importTrace':
        void this.importTrace();
        break;
      case 'refresh':
        void this.scanWorkspace(vscode.window.activeTextEditor?.document.uri).then(() => {
          if (this.activeTab === 'call') void this.ensureCallGraph(true);
        });
        break;
      case 'focus':
        void this.scanWorkspace(vscode.window.activeTextEditor?.document.uri).then(() => {
          if (this.activeTab === 'call') void this.ensureCallGraph(true);
        });
        break;
      case 'copy':
        void this.copyMap();
        break;
      case 'guide':
        void this.generateGuide();
        break;
      case 'setup':
        void vscode.commands.executeCommand('snipsense.setup');
        break;
      case 'openFile':
        if (typeof message.path === 'string') {
          const line = typeof message.line === 'number' ? message.line : undefined;
          void this.openFile(message.path, line);
        }
        break;
      default:
        break;
    }
  }

  private async scanWorkspace(focusUri?: vscode.Uri): Promise<void> {
    if (!this.panel) return;
    const generation = ++this.scanGeneration;
    this.abort?.abort();
    this.scanError = '';
    this.post({ type: 'scanning' });

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'SnipSense 正在生成仓库地图',
          cancellable: false,
        },
        async (progress) =>
          scanWorkspaceRepoMap(focusUri, (message) => progress.report({ message })),
      );

      if (generation !== this.scanGeneration || !this.panel) return;
      if (!result) {
        this.scanError = '请先打开一个工作区文件夹，再生成仓库地图。';
        this.post({ type: 'error', message: this.scanError });
        return;
      }

      this.scan = result;
      this.callGraph = undefined;
      this.post({ type: 'map', map: result.map });
      this.output.appendLine(
        `[map] ${result.map.scannedFiles} files, ${result.map.edges.length} edges`,
      );
    } catch (error) {
      if (generation !== this.scanGeneration || !this.panel) return;
      const message = error instanceof Error ? error.message : String(error);
      this.scanError = message;
      this.output.appendLine(`[map] scan failed: ${message}`);
      this.post({ type: 'error', message });
    }
  }

  private async ensureCallGraph(force = false): Promise<void> {
    if (!this.scan || !this.panel || this.callLoading) return;
    if (this.callGraph && !force) {
      this.post({ type: 'callGraph', graph: this.callGraph });
      return;
    }

    this.callLoading = true;
    this.post({ type: 'callLoading' });
    try {
      const graph = buildCallGraph(this.scan.sources, this.scan.map.focus);
      this.callGraph = graph;
      this.post({ type: 'callGraph', graph });
      this.output.appendLine(`[call] ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[call] failed: ${message}`);
      this.post({ type: 'callError', message });
    } finally {
      this.callLoading = false;
    }
  }

  private async importTrace(): Promise<void> {
    if (!this.panel || this.traceLoading) return;
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: '导入运行轨迹',
      filters: { 'Trace JSON': ['json'] },
    });
    if (!picked?.[0]) return;

    this.traceLoading = true;
    this.activeTab = 'trace';
    this.post({ type: 'tab', tab: 'trace' });
    this.post({ type: 'traceLoading' });
    try {
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const parsed = parseChromeTrace(
        JSON.parse(text) as unknown,
        picked[0].path.split('/').pop() ?? 'trace.json',
      );
      this.trace = parsed;
      this.post({ type: 'trace', model: parsed });
      this.output.appendLine(
        `[trace] ${parsed.totalEvents} events, ${parsed.durationMs.toFixed(1)}ms`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[trace] failed: ${message}`);
      this.post({ type: 'traceError', message });
    } finally {
      this.traceLoading = false;
    }
  }

  private async generateGuide(): Promise<void> {
    if (!this.scan) return;
    const settings = readSettings();
    const apiKey = await getApiKey(this.context, settings.provider);
    if (PROVIDERS[settings.provider].requiresKey && !apiKey) {
      this.post({
        type: 'guideError',
        message: '还没有配置 API Key。先设置模型，再生成 AI 导读。',
        setup: true,
      });
      return;
    }

    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.post({ type: 'guideStart' });

    try {
      const endpoint = normalizeEndpoint(resolveApiBase(settings));
      const model = resolveModel(settings);
      let text = '';
      let pending = '';
      let lastEmit = 0;

      for await (const chunk of streamChat(
        {
          provider: settings.provider,
          endpoint,
          model,
          apiKey,
          maxTokens: Math.max(settings.maxTokens, 900),
          temperature: settings.temperature,
          timeoutMs: 120_000,
        },
        buildRepoGuideMessages(this.scan.map, settings),
        { signal: abort.signal },
      )) {
        text += chunk;
        pending += chunk;
        const now = Date.now();
        if (now - lastEmit > 60) {
          lastEmit = now;
          // Coalesce chunks so the webview receives every character exactly
          // once, even when the provider sends faster than the repaint rate.
          this.post({ type: 'guideChunk', chunk: pending });
          pending = '';
        }
      }

      if (!text.trim()) {
        throw new LlmError('模型没有返回导读内容，请重试或换一个模型。');
      }
      if (pending) this.post({ type: 'guideChunk', chunk: pending });
      this.post({ type: 'guideDone' });
      this.output.appendLine(`[map] guide generated (${text.length} chars) via ${model}`);
    } catch (error) {
      if (abort.signal.aborted || isAbortError(error)) return;
      const message =
        error instanceof Error && error.message ? error.message : '生成导读失败，请稍后重试。';
      const detail = error instanceof LlmError ? error.detail : undefined;
      this.output.appendLine(`[map] guide failed: ${message}${detail ? ` | ${detail}` : ''}`);
      this.post({ type: 'guideError', message });
    }
  }

  private async copyMap(): Promise<void> {
    if (!this.scan) return;
    const summary = buildRepoMapSummary(this.scan.map, readSettings().outputLanguage);
    await vscode.env.clipboard.writeText(summary);
    this.post({ type: 'copied' });
  }

  private async openFile(path: string, line?: number): Promise<void> {
    let uri: vscode.Uri;
    if (this.scan && !isAbsolutePath(path)) {
      uri = vscode.Uri.joinPath(this.scan.rootUri, path);
      if (!isInside(this.scan.rootUri, uri)) return;
    } else {
      uri = vscode.Uri.file(path);
    }

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const selection =
        line && Number.isFinite(line)
          ? new vscode.Range(
              Math.max(0, Math.floor(line) - 1),
              0,
              Math.max(0, Math.floor(line) - 1),
              0,
            )
          : undefined;
      await vscode.window.showTextDocument(document, {
        preview: false,
        selection,
      });
    } catch {
      // File may have moved since the map was generated.
    }
  }

  private post(message: unknown): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'repoMap.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'repoMap.css'),
    );

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>SnipSense 代码工作流</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function isInside(root: vscode.Uri, candidate: vscode.Uri): boolean {
  return candidate.path === root.path || candidate.path.startsWith(`${root.path}/`);
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < 32; index += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
