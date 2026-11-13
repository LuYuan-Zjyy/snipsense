import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

// DSH/Electron shells can inherit ELECTRON_RUN_AS_NODE=1, which turns
// Code.exe into a plain Node process instead of launching the editor.
delete process.env.ELECTRON_RUN_AS_NODE;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const executable =
  process.env.VSCODE_EXECUTABLE_PATH ??
  (process.platform === 'win32' ? 'E:\\Microsoft VS Code\\Code.exe' : undefined);

if (!executable) {
  console.error('Set VSCODE_EXECUTABLE_PATH to a VS Code executable to run integration tests.');
  process.exit(1);
}

try {
  const launchArgs = [
    path.join(root, 'test', 'fixtures', 'workspace'),
    '--disable-gpu',
    '--skip-welcome',
    '--skip-release-notes',
  ];
  if (process.env.SNIPSENSE_DISABLE_BUILTINS === '1') {
    launchArgs.push('--disable-extensions');
  }

  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test', 'integration', 'suite.cjs'),
    // Built-in language features stay enabled by default: the reference
    // provider is part of the TS/JS language service and is needed to verify
    // cross-file usages. Set SNIPSENSE_DISABLE_BUILTINS=1 to exercise the
    // static Ctrl+click fallback without a language server.
    launchArgs,
  });
} catch (error) {
  console.error('Integration tests failed.');
  console.error(error);
  process.exit(1);
}
