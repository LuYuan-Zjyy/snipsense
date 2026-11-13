import * as vscode from 'vscode';
import { LlmError, streamChat } from './core/client';
import {
  PROVIDERS,
  endpointHost,
  isLocalEndpoint,
  isProviderId,
  normalizeEndpoint,
  resolveApiBase,
  resolveModel,
} from './core/endpoint';
import { buildConnectionMessages } from './core/prompts';
import { isAbortError } from './core/text';
import type { ProviderId } from './core/types';
import { CardViewProvider } from './vscode/cardView';
import { ExplainerController } from './vscode/controller';
import { getApiKey, readSettings, saveApiKey } from './vscode/config';
import { StaticDefinitionProvider } from './vscode/navigation';

interface ProviderItem extends vscode.QuickPickItem {
  id: ProviderId;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SnipSense');
  const version = String(context.extension.packageJSON.version ?? '0.1.0');
  const card = new CardViewProvider(context.extensionUri, version);
  const controller = new ExplainerController(context, card, output);
  const navigation = new StaticDefinitionProvider(output);

  context.subscriptions.push(
    output,
    controller,
    vscode.languages.registerDefinitionProvider({ scheme: 'file' }, navigation),
    vscode.window.registerWebviewViewProvider('snipsense.card', card, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('snipsense.explainSelection', () => controller.explain()),
    vscode.commands.registerCommand('snipsense.openCard', () => void card.reveal()),
    vscode.commands.registerCommand('snipsense.goToDefinition', () => goToDefinition(navigation)),
    vscode.commands.registerCommand('snipsense.setup', () => configureModel(context, controller)),
    vscode.commands.registerCommand('snipsense.testConnection', () =>
      testConnection(context, output),
    ),
    vscode.commands.registerCommand('snipsense.toggleAuto', () => controller.toggleAutoCommand()),
    vscode.commands.registerCommand('snipsense.clearCache', () => clearCache(controller, output)),
  );

  output.appendLine(`[activate] SnipSense ${version}`);
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

async function goToDefinition(navigation: StaticDefinitionProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const tokenSource = new vscode.CancellationTokenSource();
  try {
    const locations = await navigation.provideDefinition(
      editor.document,
      editor.selection.active,
      tokenSource.token,
      true,
    );
    if (!locations || locations.length === 0) {
      void vscode.window.showInformationMessage(
        'SnipSense 没有找到这个符号的静态定义。可以按 F12 试试语言服务。',
      );
      return;
    }

    const location = locations[0];
    if (!location) return;
    const document = await vscode.workspace.openTextDocument(location.uri);
    const target = await vscode.window.showTextDocument(document, { preview: false });
    target.selection = new vscode.Selection(location.range.start, location.range.start);
    target.revealRange(location.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } finally {
    tokenSource.dispose();
  }
}

async function configureModel(
  context: vscode.ExtensionContext,
  controller: ExplainerController,
): Promise<void> {
  const settings = readSettings();
  const items: ProviderItem[] = (Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
    const preset = PROVIDERS[id];
    return {
      id,
      label: preset.label,
      description: id === settings.provider ? '当前' : '',
      detail: preset.baseUrl ? `${preset.description} · ${preset.baseUrl}` : preset.description,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'SnipSense · 选择模型服务',
    placeHolder: '解释代码时使用哪个模型？',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  const id = isProviderId(picked.id) ? picked.id : settings.provider;
  const preset = PROVIDERS[id];

  let apiBase = '';
  let model = '';
  if (id === 'custom') {
    const base = await vscode.window.showInputBox({
      title: 'SnipSense · 自定义接口',
      prompt: 'OpenAI 兼容接口地址，例如 https://api.example.com/v1',
      value: settings.apiBase,
      placeHolder: 'https://api.example.com/v1',
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          normalizeEndpoint(value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : '地址格式不正确';
        }
      },
    });
    if (base === undefined) return;
    apiBase = base.trim();

    const modelName = await vscode.window.showInputBox({
      title: 'SnipSense · 自定义接口',
      prompt: '模型名称（必须与接口支持的名称一致）',
      value: settings.model,
      placeHolder: 'your-model-name',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : '请填写模型名称'),
    });
    if (modelName === undefined) return;
    model = modelName.trim();
  } else {
    const modelName = await vscode.window.showInputBox({
      title: `SnipSense · ${preset.label}`,
      prompt: `模型名称；留空使用默认的 ${preset.model}`,
      value: settings.provider === id ? settings.model : '',
      placeHolder: preset.model,
      ignoreFocusOut: true,
    });
    if (modelName === undefined) return;
    model = modelName.trim();
  }

  let apiKey = '';
  let existingKey = false;
  if (preset.requiresKey) {
    existingKey = Boolean(await getApiKey(context, id));
    const key = await vscode.window.showInputBox({
      title: `SnipSense · ${preset.label} API Key`,
      prompt: '只保存在本机 VS Code SecretStorage，不会写入设置文件。',
      password: true,
      placeHolder: existingKey ? '已保存，留空保持不变' : '粘贴 API Key',
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    apiKey = key.trim();
  }

  if (apiBase) {
    const insecure = !apiBase.trim().toLowerCase().startsWith('https://');
    if (insecure && !isLocalEndpoint(normalizeEndpoint(apiBase))) {
      const proceed = await vscode.window.showWarningMessage(
        '这个接口不是 HTTPS，选中的代码会以明文发送。确定继续吗？',
        { modal: true },
        '继续',
        '取消',
      );
      if (proceed !== '继续') return;
    }
  }

  const config = vscode.workspace.getConfiguration('snipsense');
  await config.update('provider', id, vscode.ConfigurationTarget.Global);
  await config.update('apiBase', apiBase, vscode.ConfigurationTarget.Global);
  await config.update('model', model, vscode.ConfigurationTarget.Global);
  if (apiKey) await saveApiKey(context, id, apiKey);

  await context.globalState.update('snipsense.hasConfigured', true);
  await controller.refreshKeyState();

  const effectiveModel = resolveModel(readSettings());
  if (preset.requiresKey && !apiKey && !existingKey) {
    void vscode.window.showWarningMessage(
      `已选择 ${preset.label}，但还没有配置 API Key。SnipSense 暂时无法发起解释。`,
      '知道了',
    );
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `SnipSense 已切换到 ${preset.label} · ${effectiveModel || preset.model}`,
    '测试连接',
    '打开词典',
  );
  if (action === '测试连接') {
    await vscode.commands.executeCommand('snipsense.testConnection');
  } else if (action === '打开词典') {
    await vscode.commands.executeCommand('snipsense.openCard');
  }
}

async function testConnection(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  const settings = readSettings();
  const preset = PROVIDERS[settings.provider];
  const apiKey = await getApiKey(context, settings.provider);

  if (preset.requiresKey && !apiKey) {
    const action = await vscode.window.showWarningMessage(
      `还没有配置 ${preset.label} 的 API Key。`,
      '去设置',
    );
    if (action === '去设置') await vscode.commands.executeCommand('snipsense.setup');
    return;
  }

  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(resolveApiBase(settings));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'API 地址不正确。';
    const action = await vscode.window.showErrorMessage(`SnipSense：${message}`, '去设置');
    if (action === '去设置') await vscode.commands.executeCommand('snipsense.setup');
    return;
  }

  const model = resolveModel(settings);
  output.appendLine(
    `[test] ${preset.label} · ${model || '(no model)'} · ${endpointHost(endpoint)}`,
  );

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `SnipSense 正在测试 ${preset.label} · ${model || '模型'}`,
      cancellable: true,
    },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      const started = Date.now();

      try {
        let answer = '';
        for await (const chunk of streamChat(
          {
            provider: settings.provider,
            endpoint,
            model,
            apiKey,
            maxTokens: 16,
            temperature: 0,
            timeoutMs: 25_000,
          },
          buildConnectionMessages(),
          { signal: abort.signal },
        )) {
          answer += chunk;
        }

        if (token.isCancellationRequested || !answer.trim()) {
          if (!token.isCancellationRequested) {
            throw new Error('模型返回了空内容。');
          }
          return;
        }

        const elapsed = Date.now() - started;
        output.appendLine(`[test] ok in ${elapsed}ms`);
        void vscode.window.showInformationMessage(
          `SnipSense 连接成功：${preset.label} · ${model || '模型'}（${elapsed} ms）`,
        );
      } catch (error) {
        if (token.isCancellationRequested || isAbortError(error)) return;
        const message = error instanceof Error ? error.message : '未知错误';
        const detail = error instanceof LlmError ? error.detail : undefined;
        output.appendLine(`[test] failed: ${message}${detail ? ` | ${detail}` : ''}`);
        const action = await vscode.window.showErrorMessage(
          `SnipSense 连接失败：${message}`,
          '去设置',
          '查看日志',
        );
        if (action === '去设置') {
          await vscode.commands.executeCommand('snipsense.setup');
        } else if (action === '查看日志') {
          output.show(true);
        }
      }
    },
  );
}

async function clearCache(
  controller: ExplainerController,
  output: vscode.OutputChannel,
): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    '清除本机缓存的代码解释？不会删除 API Key 或模型设置。',
    { modal: true },
    '清除',
  );
  if (confirmed !== '清除') return;
  controller.clearCacheNow();
  output.appendLine('[cache] cleared by command');
  void vscode.window.showInformationMessage('SnipSense：解释缓存已清除。');
}
