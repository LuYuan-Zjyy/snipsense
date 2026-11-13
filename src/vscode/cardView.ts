import * as vscode from 'vscode';
import type { CardState, QuickAction } from '../core/types';

export interface CardActions {
  onReady(): void;
  explain(): void;
  retry(): void;
  quick(kind: QuickAction): void;
  ask(text: string): void;
  setup(): void;
  openSettings(): void;
  testConnection(): void;
  toggleAuto(value: boolean): void;
  pin(value: boolean): void;
  copy(): void;
  openFile(): void;
  openRelated(uri: string, line: number): void;
  openLink(url: string): void;
  clearCache(): void;
}

interface UiMessage {
  type?: unknown;
  text?: unknown;
  value?: unknown;
  kind?: unknown;
  url?: unknown;
  uri?: unknown;
  line?: unknown;
}

export class CardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private state: CardState;
  private readonly disposables: vscode.Disposable[] = [];
  actions: CardActions | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    version: string,
  ) {
    this.state = {
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
      multiFile: vscode.workspace.getConfiguration('snipsense').get<boolean>('multiFile', true),
      untrusted: !vscode.workspace.isTrusted,
      version,
    };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    view.webview.html = this.html(view.webview);

    this.disposables.push(
      view.webview.onDidReceiveMessage((message: UiMessage) => this.handle(message)),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          view.badge = undefined;
          this.actions?.onReady();
        }
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    );

    this.post();
  }

  setState(state: CardState): void {
    this.state = state;
    if (this.view) {
      this.view.description = state.model || undefined;
      if (state.status === 'done' && !this.view.visible) {
        this.view.badge = { value: 1, tooltip: 'SnipSense 读完了这段代码' };
      }
      if (state.status !== 'done') {
        this.view.badge = undefined;
      }
    }
    this.post();
  }

  async reveal(): Promise<void> {
    try {
      await vscode.commands.executeCommand('snipsense.card.focus');
    } catch {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.snipsense');
      } catch {
        // The view container can be unavailable during shutdown.
      }
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.view = undefined;
  }

  private post(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ type: 'state', state: this.state });
  }

  private handle(message: UiMessage): void {
    if (!message || typeof message.type !== 'string') return;
    const actions = this.actions;
    if (!actions) return;

    switch (message.type) {
      case 'ready':
        actions.onReady();
        this.post();
        break;
      case 'explain':
        actions.explain();
        break;
      case 'retry':
        actions.retry();
        break;
      case 'quick':
        if (isQuickAction(message.kind)) actions.quick(message.kind);
        break;
      case 'ask':
        if (typeof message.text === 'string') actions.ask(message.text);
        break;
      case 'setup':
        actions.setup();
        break;
      case 'openSettings':
        actions.openSettings();
        break;
      case 'test':
        actions.testConnection();
        break;
      case 'toggleAuto':
        if (typeof message.value === 'boolean') actions.toggleAuto(message.value);
        break;
      case 'pin':
        if (typeof message.value === 'boolean') actions.pin(message.value);
        break;
      case 'copy':
        actions.copy();
        break;
      case 'openFile':
        actions.openFile();
        break;
      case 'openRelated':
        if (
          typeof message.uri === 'string' &&
          typeof message.line === 'number' &&
          Number.isFinite(message.line)
        ) {
          actions.openRelated(message.uri, message.line);
        }
        break;
      case 'openLink':
        if (typeof message.url === 'string') actions.openLink(message.url);
        break;
      case 'clearCache':
        actions.clearCache();
        break;
      default:
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'),
    );

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>SnipSense</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function isQuickAction(value: unknown): value is QuickAction {
  return value === 'simpler' || value === 'example' || value === 'why';
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < 32; index += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
