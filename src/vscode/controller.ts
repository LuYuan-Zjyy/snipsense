import * as vscode from 'vscode';
import type { CardActions } from './cardView';
import { CardViewProvider } from './cardView';
import { ExplanationCache, createCacheKey } from '../core/cache';
import { LlmError, streamChat } from '../core/client';
import {
  PROVIDERS,
  normalizeEndpoint,
  providerLabel,
  resolveApiBase,
  resolveModel,
} from '../core/endpoint';
import { type GraphData, graphDataFromView, toGraphView } from '../core/graph';
import { ExplanationStream } from '../core/parser';
import { buildExplainMessages, buildFollowupMessages, quickQuestion } from '../core/prompts';
import { isAbortError, truncate } from '../core/text';
import type {
  AppSettings,
  CardState,
  Explanation,
  QuickAction,
  SelectionContext,
  Turn,
} from '../core/types';
import { getApiKey, hasApiKey, readSettings } from './config';
import { analyzeDependencies, type GraphResult } from './graph';
import {
  type CapturedSelection,
  captureSelection,
  revealSelection,
  selectionView,
} from './selection';

export class ExplainerController implements vscode.Disposable, CardActions {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar: vscode.StatusBarItem;
  private readonly cache: ExplanationCache;

  private state: CardState;
  private current: CapturedSelection | undefined;
  private currentExplanation: Explanation | undefined;
  private currentGraph: GraphData | undefined;
  private conversation: Turn[] = [];
  private pinned = false;
  private generation = 0;
  private abort: AbortController | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private glossType: vscode.TextEditorDecorationType | undefined;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly card: CardViewProvider,
    private readonly output: vscode.OutputChannel,
  ) {
    const settings = readSettings();
    this.cache = new ExplanationCache(context.globalState);
    this.statusBar = vscode.window.createStatusBarItem(
      'snipsense.status',
      vscode.StatusBarAlignment.Right,
      90,
    );
    this.statusBar.name = 'SnipSense';
    this.statusBar.command = 'snipsense.openCard';
    this.state = {
      status: 'empty',
      selection: null,
      gist: '',
      detail: '',
      error: '',
      provider: settings.provider,
      providerLabel: providerLabel(settings.provider),
      model: displayModel(settings),
      autoExplain: settings.autoExplain,
      inlineGloss: settings.inlineGloss,
      pinned: false,
      needsSetup: false,
      cached: false,
      conversation: [],
      graph: null,
      multiFile: settings.multiFile,
      untrusted: !vscode.workspace.isTrusted,
      version: context.extension.packageJSON.version as string,
    };

    this.card.actions = this;
    this.card.setState(this.state);
    this.updateStatusBar();

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => this.onSelectionChange(event)),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.onActiveEditorChange(editor)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('snipsense')) this.onConfigurationChange();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChange(event)),
    );

    void this.refreshKeyState();
  }

  // ---------------------------------------------------------------------------
  // CardActions
  // ---------------------------------------------------------------------------

  onReady(): void {
    void this.refreshKeyState();
    if (this.current) {
      this.patchState({ selection: selectionView(this.current.context) });
      return;
    }

    const settings = readSettings();
    const captured = captureSelection(vscode.window.activeTextEditor, settings);
    if (!captured) return;
    this.current = captured;
    this.patchState({
      status: 'idle',
      selection: selectionView(captured.context),
      ...baseFields(settings),
    });
    if (settings.autoExplain && vscode.workspace.isTrusted) this.schedule(captured);
  }

  explain(): void {
    void this.run('manual');
  }

  retry(): void {
    if (this.current) {
      void this.run('manual', this.current);
    } else {
      void this.run('manual');
    }
  }

  quick(kind: QuickAction): void {
    const settings = readSettings();
    this.ask(quickQuestion(kind, settings.outputLanguage));
  }

  ask(text: string): void {
    void this.followup(text);
  }

  setup(): void {
    void vscode.commands.executeCommand('snipsense.setup');
  }

  openSettings(): void {
    void vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@ext:luyuan-zjyy.snipsense',
    );
  }

  testConnection(): void {
    void vscode.commands.executeCommand('snipsense.testConnection');
  }

  toggleAuto(value: boolean): void {
    this.patchState({ autoExplain: value });
    void vscode.workspace
      .getConfiguration('snipsense')
      .update('autoExplain', value, vscode.ConfigurationTarget.Global);
    if (value && this.current && this.state.status !== 'done') {
      this.schedule(this.current);
    } else {
      this.clearDebounce();
      if (this.current && this.state.status !== 'done') {
        this.setGloss('Alt+Q 解释');
      }
    }
  }

  pin(value: boolean): void {
    this.pinned = value;
    this.patchState({ pinned: value });
    if (!value) {
      const settings = readSettings();
      const active = captureSelection(vscode.window.activeTextEditor, settings);
      if (active) this.current = active;
      if (
        active &&
        this.state.status !== 'done' &&
        settings.autoExplain &&
        vscode.workspace.isTrusted
      ) {
        this.schedule(active);
      }
    }
  }

  copy(): void {
    const text = [this.state.gist, this.state.detail].filter(Boolean).join('\n\n');
    if (!text) return;
    void vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('SnipSense：解释已复制。');
  }

  openFile(): void {
    if (!this.current) return;
    void revealSelection(this.current.context);
  }

  openRepoMap(): void {
    void vscode.commands.executeCommand('snipsense.openRepoMap');
  }

  openRelated(uri: string, line: number): void {
    const allowed =
      this.state.graph?.dependencies.some((item) => item.uri === uri) ||
      this.state.graph?.usages.some((item) => item.uri === uri);
    if (!allowed) return;

    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(uri);
    } catch {
      return;
    }
    if (parsed.scheme !== 'file' && parsed.scheme !== 'untitled') return;

    void (async () => {
      try {
        const document = await vscode.workspace.openTextDocument(parsed);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const targetLine = Math.max(0, Math.min(document.lineCount - 1, line - 1));
        const position = new vscode.Position(targetLine, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
      } catch {
        // The file may have been deleted or moved since analysis.
      }
    })();
  }

  openLink(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    void vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
  }

  clearCache(): void {
    void vscode.commands.executeCommand('snipsense.clearCache');
  }

  clearCacheNow(): void {
    this.cache.clear();
    this.output.appendLine(`[${stamp()}] cache cleared`);
  }

  toggleAutoCommand(): void {
    const value = !readSettings().autoExplain;
    this.toggleAuto(value);
    void vscode.window.showInformationMessage(`SnipSense：自动解释已${value ? '开启' : '关闭'}。`);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearDebounce();
    this.invalidate();
    this.clearGloss();
    this.statusBar.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.card.dispose();
  }

  async refreshKeyState(): Promise<void> {
    const settings = readSettings();
    const hasKey = await hasApiKey(this.context, settings.provider);
    if (this.disposed || settings.provider !== readSettings().provider) return;
    const patch: Partial<CardState> = {
      needsSetup: !hasKey,
      provider: settings.provider,
      providerLabel: providerLabel(settings.provider),
      model: displayModel(settings),
    };
    if (hasKey && this.state.status === 'setup') {
      patch.status = this.current ? 'idle' : 'empty';
      patch.selection = this.current ? selectionView(this.current.context) : null;
      patch.error = '';
    }
    this.patchState(patch);
  }

  // ---------------------------------------------------------------------------
  // Selection lifecycle
  // ---------------------------------------------------------------------------

  private onSelectionChange(event: vscode.TextEditorSelectionChangeEvent): void {
    if (this.pinned || this.disposed) return;
    if (event.textEditor !== vscode.window.activeTextEditor) return;

    const settings = readSettings();
    const captured = captureSelection(event.textEditor, settings);
    if (!captured) {
      this.onEmptySelection();
      return;
    }

    if (this.current && sameSelection(this.current.context, captured.context)) {
      if (this.state.status === 'idle' && settings.autoExplain && vscode.workspace.isTrusted) {
        this.schedule(captured);
      }
      return;
    }

    this.invalidate();
    this.clearDebounce();
    this.current = captured;
    this.currentExplanation = undefined;
    this.currentGraph = undefined;
    this.conversation = [];
    this.patchState({
      status: 'idle',
      selection: selectionView(captured.context),
      gist: '',
      detail: '',
      error: '',
      cached: false,
      conversation: [],
      graph: null,
      ...baseFields(settings),
    });
    this.clearGloss();

    if (!settings.autoExplain) {
      this.setGloss('Alt+Q 解释');
      return;
    }
    if (!vscode.workspace.isTrusted) {
      this.patchState({ untrusted: true });
      this.setGloss('Alt+Q 手动解释');
      return;
    }
    this.schedule(captured);
  }

  private onActiveEditorChange(editor: vscode.TextEditor | undefined): void {
    this.clearGloss();
    if (!this.current) return;

    if (editor === this.current.editor) {
      if (this.state.status === 'done' && this.state.gist) {
        this.setGloss(this.state.gist);
      } else if (this.state.status === 'loading' || this.state.status === 'streaming') {
        this.setGloss('解读中…');
      }
      return;
    }

    // A webview/panel can take focus and make activeTextEditor undefined. That
    // is not a document switch, so do not cancel an in-flight explanation.
    if (!editor) return;

    this.invalidate();
    this.currentGraph = undefined;
    if (this.isBusy()) {
      this.patchState({
        status: 'idle',
        gist: '',
        detail: '',
        error: '',
        graph: null,
        conversation: [],
      });
    }
  }

  private onDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (this.current?.editor.document !== event.document) return;
    this.clearGloss();
    if (this.isBusy()) {
      this.invalidate();
      this.currentGraph = undefined;
      this.patchState({
        status: 'idle',
        gist: '',
        detail: '',
        error: '',
        graph: null,
        conversation: [],
      });
    }
  }

  private onEmptySelection(): void {
    this.clearDebounce();
    this.clearGloss();
    if (this.isBusy()) {
      this.invalidate();
      this.current = undefined;
      this.currentExplanation = undefined;
      this.currentGraph = undefined;
      this.conversation = [];
      this.patchState({
        status: 'empty',
        selection: null,
        gist: '',
        detail: '',
        error: '',
        graph: null,
        conversation: [],
      });
      return;
    }
    if (this.state.status === 'idle' || this.state.status === 'error') {
      this.current = undefined;
      this.currentExplanation = undefined;
      this.currentGraph = undefined;
      this.conversation = [];
      this.patchState({
        status: 'empty',
        selection: null,
        gist: '',
        detail: '',
        error: '',
        graph: null,
        conversation: [],
      });
    }
  }

  private schedule(captured: CapturedSelection): void {
    const settings = readSettings();
    if (!settings.autoExplain || this.pinned || !vscode.workspace.isTrusted) return;
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.current && sameSelection(this.current.context, captured.context) && !this.pinned) {
        void this.run('auto', captured);
      }
    }, settings.debounceMs);
  }

  private async run(kind: 'auto' | 'manual', target?: CapturedSelection): Promise<void> {
    const settings = readSettings();
    const captured = target ?? captureSelection(vscode.window.activeTextEditor, settings);

    if (!captured) {
      if (kind === 'manual') {
        void vscode.window.showInformationMessage('先选中一段代码，再让 SnipSense 解释。');
      }
      return;
    }

    if (kind === 'manual') {
      await this.card.reveal();
    }

    if (kind === 'auto' && !vscode.workspace.isTrusted) {
      this.setGloss('Alt+Q 手动解释');
      return;
    }

    this.clearDebounce();
    this.invalidate();
    const runId = this.generation;
    this.current = captured;
    this.conversation = [];
    this.currentExplanation = undefined;
    this.currentGraph = undefined;
    this.patchState({
      status: 'loading',
      selection: selectionView(captured.context),
      gist: '',
      detail: '',
      error: '',
      cached: false,
      conversation: [],
      graph: null,
      ...baseFields(settings),
    });
    this.setGloss('解读中…');

    try {
      const apiKey = await getApiKey(this.context, settings.provider);
      if (runId !== this.generation) return;

      if (PROVIDERS[settings.provider].requiresKey && !apiKey) {
        this.showSetup(kind === 'manual');
        return;
      }

      const endpoint = normalizeEndpoint(resolveApiBase(settings));
      const model = displayModel(settings);
      this.patchState({ model, needsSetup: false });

      let graph: GraphResult | undefined;
      if (settings.multiFile) {
        try {
          graph = (await analyzeDependencies(captured.context, settings, this.output)) ?? undefined;
        } catch (error) {
          this.output.appendLine(
            `[${stamp()}] graph analysis failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (runId !== this.generation) return;
        if (graph) {
          this.currentGraph = graph.data;
          this.patchState({ graph: toGraphView(graph.data) });
        }
      }

      const cacheKey = createCacheKey({
        provider: settings.provider,
        endpoint,
        model,
        language: settings.outputLanguage,
        style: settings.explainStyle,
        code: captured.context.code,
        before: captured.context.before,
        after: captured.context.after,
        related: graph?.signature ?? '',
      });

      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.currentExplanation = { gist: cached.gist, detail: cached.detail };
        this.currentGraph = cached.graph ? graphDataFromView(cached.graph) : graph?.data;
        this.patchState({
          status: 'done',
          gist: cached.gist,
          detail: cached.detail,
          cached: true,
          error: '',
          graph: cached.graph ?? (graph ? toGraphView(graph.data) : null),
        });
        this.setGloss(cached.gist);
        this.output.appendLine(`[${stamp()}] cache hit ${model} (${cached.detail.length} chars)`);
        return;
      }

      const { signal } = this.beginRequest();
      const parser = new ExplanationStream();
      let lastEmit = 0;
      let sawGist = false;

      for await (const chunk of streamChat(
        {
          provider: settings.provider,
          endpoint,
          model,
          apiKey,
          maxTokens: settings.maxTokens,
          temperature: settings.temperature,
        },
        buildExplainMessages(captured.context, settings, graph?.data),
        { signal },
      )) {
        if (runId !== this.generation) return;
        const partial = parser.push(chunk);
        const now = Date.now();
        if (now - lastEmit > 60 || (partial.gist && !sawGist)) {
          lastEmit = now;
          sawGist = sawGist || partial.hasGist;
          this.patchState({
            status: 'streaming',
            gist: partial.gist,
            detail: partial.detail,
          });
          if (partial.gist) this.setGloss(partial.gist);
        }
      }

      if (runId !== this.generation) return;
      const final = parser.finish();
      if (!final.gist && !final.detail) {
        throw new LlmError('模型返回了空内容，请重试或换一个模型。');
      }

      this.currentExplanation = final;
      this.cache.set(cacheKey, final, model, graph ? toGraphView(graph.data) : undefined);
      this.patchState({
        status: 'done',
        gist: final.gist,
        detail: final.detail,
        cached: false,
        error: '',
        graph: graph ? toGraphView(graph.data) : this.state.graph,
      });
      this.setGloss(final.gist);
      this.output.appendLine(
        `[${stamp()}] explained ${captured.context.file}:${captured.context.startLine}-${captured.context.endLine} via ${model} (${final.detail.length} chars)`,
      );
    } catch (error) {
      if (runId !== this.generation || isAbortError(error)) return;
      this.handleError(error);
    }
  }

  private async followup(rawQuestion: string): Promise<void> {
    const question = rawQuestion.trim().slice(0, 500);
    if (!question) return;

    if (!this.current || !this.currentExplanation) {
      void vscode.window.showInformationMessage('先让 SnipSense 解释这段代码，再继续追问。');
      return;
    }
    if (this.isBusy()) {
      void vscode.window.showInformationMessage('等这段代码解释完，再追问。');
      return;
    }

    const settings = readSettings();
    const target = this.current;
    const explanation = this.currentExplanation;
    const apiKey = await getApiKey(this.context, settings.provider);
    if (PROVIDERS[settings.provider].requiresKey && !apiKey) {
      this.showSetup(false);
      return;
    }
    if (this.current !== target || this.currentExplanation !== explanation) return;

    this.clearDebounce();
    this.invalidate();
    const runId = this.generation;
    const turn: Turn = { question, answer: '', pending: true };
    this.conversation = [...this.conversation, turn].slice(-6);
    this.patchState({ status: 'streaming', conversation: cloneTurns(this.conversation) });

    try {
      const endpoint = normalizeEndpoint(resolveApiBase(settings));
      const model = displayModel(settings);
      const { signal } = this.beginRequest();
      let answer = '';
      let lastEmit = 0;

      for await (const chunk of streamChat(
        {
          provider: settings.provider,
          endpoint,
          model,
          apiKey,
          maxTokens: settings.maxTokens,
          temperature: settings.temperature,
        },
        buildFollowupMessages(
          target.context,
          settings,
          explanation,
          this.conversation.filter((item) => item !== turn),
          question,
          this.currentGraph,
        ),
        { signal },
      )) {
        if (runId !== this.generation) return;
        answer += chunk;
        turn.answer = answer;
        const now = Date.now();
        if (now - lastEmit > 60) {
          lastEmit = now;
          this.patchState({ conversation: cloneTurns(this.conversation) });
        }
      }

      if (runId !== this.generation) return;
      if (!answer.trim()) throw new LlmError('模型没有回答这个问题，请换个问法。');
      turn.pending = false;
      this.patchState({
        status: 'done',
        conversation: cloneTurns(this.conversation),
        error: '',
      });
    } catch (error) {
      if (runId !== this.generation || isAbortError(error)) return;
      turn.pending = false;
      turn.error = error instanceof Error ? error.message : '回答失败，请重试。';
      this.patchState({ status: 'done', conversation: cloneTurns(this.conversation) });
      this.output.appendLine(
        `[${stamp()}] follow-up failed: ${turn.error}${
          error instanceof LlmError && error.detail ? ` | ${error.detail}` : ''
        }`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // State / status
  // ---------------------------------------------------------------------------

  private showSetup(notify: boolean): void {
    this.currentExplanation = undefined;
    this.currentGraph = undefined;
    this.patchState({
      status: 'setup',
      needsSetup: true,
      gist: '',
      detail: '',
      error: '',
      conversation: [],
      graph: null,
    });
    this.clearGloss();
    if (notify) {
      void vscode.window
        .showInformationMessage(
          `SnipSense 还没有连接 ${providerLabel(readSettings().provider)}，先配置一个模型。`,
          '设置',
        )
        .then((choice) => {
          if (choice === '设置') this.setup();
        });
    }
  }

  private handleError(error: unknown): void {
    const message =
      error instanceof Error && error.message ? error.message : '解释失败，请稍后重试。';
    const detail = error instanceof LlmError ? error.detail : undefined;
    this.output.appendLine(`[${stamp()}] error: ${message}${detail ? ` | ${detail}` : ''}`);

    this.patchState({
      status: 'error',
      gist: '',
      detail: '',
      error: message,
      needsSetup: error instanceof LlmError && error.status === 401,
      conversation: [],
    });
    this.clearGloss();
  }

  private patchState(patch: Partial<CardState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.card.setState(this.state);
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const settings = readSettings();
    if (!settings.showStatusBar) {
      this.statusBar.hide();
      return;
    }

    this.statusBar.show();
    const selection = this.state.selection;
    const location = selection ? `${selection.file}:${selection.startLine}` : '选中代码';

    if (this.state.status === 'loading' || this.state.status === 'streaming') {
      this.statusBar.text = '$(sync~spin) SnipSense';
      this.statusBar.tooltip = `正在解读 ${location} · 点击打开代码词典`;
    } else if (this.state.status === 'setup' || this.state.needsSetup) {
      this.statusBar.text = '$(key) SnipSense';
      this.statusBar.tooltip = '还没有连接模型 · 点击配置 API Key';
    } else if (this.state.status === 'error') {
      this.statusBar.text = '$(warning) SnipSense';
      this.statusBar.tooltip = `${truncate(this.state.error, 120)} · 点击重试`;
    } else if (this.state.status === 'done') {
      this.statusBar.text = '$(lightbulb) SnipSense';
      this.statusBar.tooltip = `已解释 ${location} · 点击打开代码词典`;
    } else {
      this.statusBar.text = '$(lightbulb) SnipSense';
      this.statusBar.tooltip = '选中代码，像查字典一样读懂 · Alt+Q';
    }
  }

  private async onConfigurationChange(): Promise<void> {
    const settings = readSettings();
    const previousProvider = this.state.provider;
    const previousModel = this.state.model;
    const providerChanged =
      previousProvider !== settings.provider || previousModel !== displayModel(settings);
    const multiFileChanged = this.state.multiFile !== settings.multiFile;

    this.patchState({
      autoExplain: settings.autoExplain,
      inlineGloss: settings.inlineGloss,
      untrusted: !vscode.workspace.isTrusted,
      ...baseFields(settings),
    });

    if (!settings.inlineGloss) this.clearGloss();
    if (!settings.showStatusBar) this.statusBar.hide();
    else this.updateStatusBar();

    if (!settings.autoExplain) this.clearDebounce();
    if (providerChanged || multiFileChanged) {
      this.currentExplanation = undefined;
      this.currentGraph = undefined;
      this.conversation = [];
      this.patchState({ graph: null });
      if (this.current) {
        this.patchState({
          status: 'idle',
          selection: selectionView(this.current.context),
          gist: '',
          detail: '',
          error: '',
          conversation: [],
          graph: null,
        });
        this.setGloss('Alt+Q 解释');
      }
    } else if (settings.inlineGloss && this.state.status === 'done' && this.state.gist) {
      this.setGloss(this.state.gist);
    }

    await this.refreshKeyState();
  }

  // ---------------------------------------------------------------------------
  // Inline gloss
  // ---------------------------------------------------------------------------

  private setGloss(gist: string): void {
    const settings = readSettings();
    if (!settings.inlineGloss || !this.current) {
      this.clearGloss();
      return;
    }

    const editor = this.current.editor;
    const gistText = truncate(gist.replace(/\s+/g, ' ').trim(), 64);
    if (!gistText || editor.document.isClosed || editor !== vscode.window.activeTextEditor) {
      this.clearGloss();
      return;
    }

    this.clearGloss();
    this.glossType = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: `✦ ${gistText}`,
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 1.4em',
        textDecoration: 'none',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    const end = decorationPosition(editor, this.current.range);
    const hover = new vscode.MarkdownString();
    hover.appendText('SnipSense');
    hover.appendMarkdown('\n\n');
    hover.appendText(gistText);
    hover.appendMarkdown('\n\n[查看完整解释](command:snipsense.openCard)');
    hover.isTrusted = { enabledCommands: ['snipsense.openCard'] };
    hover.supportThemeIcons = true;

    editor.setDecorations(this.glossType, [
      {
        range: new vscode.Range(end, end),
        hoverMessage: hover,
      },
    ]);
  }

  private clearGloss(): void {
    this.glossType?.dispose();
    this.glossType = undefined;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private isBusy(): boolean {
    return this.state.status === 'loading' || this.state.status === 'streaming';
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  private invalidate(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = undefined;
  }

  private beginRequest(): { signal: AbortSignal } {
    this.abort?.abort();
    this.abort = new AbortController();
    return { signal: this.abort.signal };
  }
}

function baseFields(settings: AppSettings): Partial<CardState> {
  return {
    provider: settings.provider,
    providerLabel: providerLabel(settings.provider),
    model: displayModel(settings),
    autoExplain: settings.autoExplain,
    inlineGloss: settings.inlineGloss,
    multiFile: settings.multiFile,
    untrusted: !vscode.workspace.isTrusted,
  };
}

function displayModel(settings: AppSettings): string {
  const model = resolveModel(settings).trim();
  return model || '自定义模型';
}

function sameSelection(left: SelectionContext, right: SelectionContext): boolean {
  return (
    left.uri === right.uri &&
    left.code === right.code &&
    left.startLine === right.startLine &&
    left.endLine === right.endLine
  );
}

function decorationPosition(editor: vscode.TextEditor, range: vscode.Range): vscode.Position {
  let position = range.end;
  if (position.character === 0 && position.line > range.start.line) {
    const line = Math.max(0, position.line - 1);
    position = new vscode.Position(line, editor.document.lineAt(line).text.length);
  }
  return position;
}

function cloneTurns(turns: Turn[]): Turn[] {
  return turns.map((turn) => ({ ...turn }));
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}
