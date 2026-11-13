import * as vscode from 'vscode';
import { parseImports } from '../core/graph';
import {
  type DefinitionPosition,
  findDefaultExport,
  findImportBinding,
  findLocalDefinitions,
  qualifiedWordAt,
  stringLiteralAt,
  wordAt,
} from '../core/navigation';
import { readSettings } from './config';
import { resolveImportTarget } from './graph';

/**
 * A deliberately conservative, token-free fallback for Ctrl+click / F12.
 * It resolves local declarations, imported symbols and import paths using the
 * same static graph as the explainer. The language server still runs first;
 * this provider only adds a result when it has direct evidence.
 */
export class StaticDefinitionProvider implements vscode.DefinitionProvider {
  private suppress = false;

  constructor(private readonly output: vscode.OutputChannel) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    forceStatic = false,
  ): Promise<vscode.Location[] | undefined> {
    try {
      if (this.suppress || token.isCancellationRequested || !readSettings().quickJump) {
        return undefined;
      }
      if (document.uri.scheme !== 'file') return undefined;

      // If the language server already knows a definition, defer to it. This
      // keeps Ctrl+click free of duplicate results in VS Code and leaves the
      // static fallback for editors/languages where it returns nothing.
      if (!forceStatic && (await this.hasLanguageDefinition(document, position, token))) {
        return undefined;
      }

      const text = document.getText();
      const offset = document.offsetAt(position);
      const imports = parseImports(text, document.languageId);

      // Ctrl+click on an import path string opens the target file.
      const literal = stringLiteralAt(text, offset);
      if (literal) {
        const entry = imports.find((candidate) => candidate.source === literal.value);
        if (entry) {
          const target = await resolveImportTarget(document, entry.source);
          if (target) return [fileStart(target.uri)];
        }
      }

      const qualified = qualifiedWordAt(text, offset);
      const word = qualified?.word ?? wordAt(text, offset);
      if (!word) return undefined;

      // ns.foo / module.foo: only resolve when ns is a namespace import.
      if (qualified) {
        const match = findImportBinding(imports, qualified.qualifier);
        if (!match || match.binding.kind !== 'namespace') return undefined;
        return this.targetLocations(document, match.entry.source, qualified.word.text, token);
      }

      // Local declarations take precedence over imports.
      const local = findLocalDefinitions(text, word.text, document.languageId);
      if (local.length > 0) return locationsFor(document.uri, local);

      const match = findImportBinding(imports, word.text);
      if (!match) return undefined;
      if (match.binding.kind === 'namespace' || match.binding.importedName === '*') {
        const target = await resolveImportTarget(document, match.entry.source);
        return target ? [fileStart(target.uri)] : undefined;
      }

      return this.targetLocations(document, match.entry.source, match.binding.importedName, token);
    } catch (error) {
      this.output.appendLine(`[jump] ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async hasLanguageDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    this.suppress = true;
    try {
      const result = await vscode.commands.executeCommand<
        vscode.Location[] | vscode.LocationLink[]
      >('vscode.executeDefinitionProvider', document.uri, position);
      return !token.isCancellationRequested && Array.isArray(result) && result.length > 0;
    } catch {
      return false;
    } finally {
      this.suppress = false;
    }
  }

  private async targetLocations(
    document: vscode.TextDocument,
    source: string,
    importedName: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    const target = await resolveImportTarget(document, source);
    if (!target || token.isCancellationRequested) return undefined;

    const targetText = target.document.getText();
    const definitions =
      importedName === 'default'
        ? defaultPosition(targetText)
        : findLocalDefinitions(targetText, importedName, target.document.languageId);

    if (definitions.length > 0) return locationsFor(target.uri, definitions);
    return [fileStart(target.uri)];
  }
}

function defaultPosition(text: string): DefinitionPosition[] {
  const position = findDefaultExport(text);
  return position ? [position] : [];
}

function locationsFor(uri: vscode.Uri, definitions: DefinitionPosition[]): vscode.Location[] {
  return definitions.map(
    (definition) =>
      new vscode.Location(uri, new vscode.Position(definition.line, definition.character)),
  );
}

function fileStart(uri: vscode.Uri): vscode.Location {
  return new vscode.Location(uri, new vscode.Position(0, 0));
}
