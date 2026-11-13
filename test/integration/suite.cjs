const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function run() {
  console.log('[SnipSense integration] starting');
  const extension = vscode.extensions.getExtension('luyuan-zjyy.snipsense');
  assert.ok(extension, 'SnipSense extension should be installed in the test host');

  await extension.activate();
  assert.equal(extension.isActive, true, 'SnipSense should activate');
  console.log('[SnipSense integration] activated');

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'snipsense.explainSelection',
    'snipsense.openCard',
    'snipsense.openRepoMap',
    'snipsense.goToDefinition',
    'snipsense.setup',
    'snipsense.testConnection',
    'snipsense.toggleAuto',
    'snipsense.clearCache',
  ]) {
    assert.ok(commands.includes(command), `Missing command: ${command}`);
  }

  // Resolve the webview view and render the card once.
  await vscode.commands.executeCommand('snipsense.openCard');
  await new Promise((resolve) => setTimeout(resolve, 500));

  const request = deferred();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      request.resolve({ body, authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content:
                  '@@GIST@@\n把两个数字相加并返回结果。\n@@DETAIL@@\n- 参数是 `left` 和 `right`\n- 返回它们的和',
              },
            },
          ],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const config = vscode.workspace.getConfiguration('snipsense');

  try {
    await config.update('provider', 'custom', vscode.ConfigurationTarget.Global);
    await config.update(
      'apiBase',
      `http://127.0.0.1:${port}/v1`,
      vscode.ConfigurationTarget.Global,
    );
    await config.update('model', 'mock-model', vscode.ConfigurationTarget.Global);
    await config.update('autoExplain', true, vscode.ConfigurationTarget.Global);
    await config.update('debounceMs', 200, vscode.ConfigurationTarget.Global);
    await config.update('multiFile', true, vscode.ConfigurationTarget.Global);
    await config.update('maxRelatedFiles', 5, vscode.ConfigurationTarget.Global);
    await config.update('maxUsages', 6, vscode.ConfigurationTarget.Global);

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The fixture workspace should be open');
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(folder.uri.fsPath, 'src', 'use-math.ts')),
    );
    const editor = await vscode.window.showTextDocument(document);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const lastLine = editor.document.lineAt(4).text;
    editor.selection = new vscode.Selection(2, 0, 4, lastLine.length);

    const payload = await waitFor(request.promise, 15_000);
    assert.match(payload.body, /use-math/);
    assert.match(payload.body, /math\.ts/);
    assert.match(payload.body, /report\.ts/);
    assert.match(payload.body, /它依赖的文件/);
    assert.match(payload.body, /add/);
    assert.match(payload.body, /mock-model/);
    assert.equal(payload.authorization, undefined);
    console.log('[SnipSense integration] mock model request received with cross-file context');

    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(editor.document.getText().includes('add(sum, value)'), true);

    // Token-free Ctrl+click fallback: put the cursor on the imported `add`
    // call and invoke the same provider through the command.
    const callLine = editor.document.lineAt(3).text;
    const addOffset = callLine.indexOf('add(');
    const definitions = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      document.uri,
      new vscode.Position(3, addOffset + 1),
    );
    assert.ok(
      Array.isArray(definitions) &&
        definitions.some((definition) => {
          const uri = definition.uri ?? definition.targetUri;
          return /math\.ts$/.test(uri?.fsPath ?? uri?.path ?? '');
        }),
      'Definition provider should resolve the imported add function',
    );

    editor.selection = new vscode.Selection(3, addOffset, 3, addOffset + 3);
    await vscode.commands.executeCommand('snipsense.goToDefinition');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.match(
      vscode.window.activeTextEditor?.document.uri.fsPath ?? '',
      /math\.ts$/,
      'Ctrl+click fallback should jump to the imported definition',
    );

    // Python absolute import from an adjacent file: the exact ViT.py /
    // layer.py layout from the bug report. It must resolve PPEmb without Pylance.
    const pythonDocument = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(folder.uri.fsPath, 'py', 'vit.py')),
    );
    const pythonEditor = await vscode.window.showTextDocument(pythonDocument);
    let ppeLine = -1;
    for (let index = 0; index < pythonDocument.lineCount; index += 1) {
      if (pythonDocument.lineAt(index).text.includes('PPEmb(img_size')) {
        ppeLine = index;
        break;
      }
    }
    assert.ok(ppeLine >= 0, 'PPEmb call should exist in the Python fixture');
    const ppeText = pythonDocument.lineAt(ppeLine).text;
    const ppeOffset = ppeText.indexOf('PPEmb(');
    const pythonDefinitions = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      pythonDocument.uri,
      new vscode.Position(ppeLine, ppeOffset + 1),
    );
    assert.ok(
      Array.isArray(pythonDefinitions) &&
        pythonDefinitions.some((definition) => {
          const uri = definition.uri ?? definition.targetUri;
          return /layer\.py$/.test(uri?.fsPath ?? uri?.path ?? '');
        }),
      'PPEmb definition provider should resolve layer.py',
    );

    pythonEditor.selection = new vscode.Selection(ppeLine, ppeOffset, ppeLine, ppeOffset + 5);
    await vscode.commands.executeCommand('snipsense.goToDefinition');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.match(
      vscode.window.activeTextEditor?.document.uri.fsPath ?? '',
      /layer\.py$/,
      'PPEmb should jump to layer.py',
    );

    // The map panel scans the fixture workspace and renders its webview.
    await vscode.commands.executeCommand('snipsense.openRepoMap');
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log('[SnipSense integration] repo map opened');
  } finally {
    await config.update('provider', 'deepseek', vscode.ConfigurationTarget.Global);
    await config.update('apiBase', '', vscode.ConfigurationTarget.Global);
    await config.update('model', '', vscode.ConfigurationTarget.Global);
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('[SnipSense integration] passed');
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitFor(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}
