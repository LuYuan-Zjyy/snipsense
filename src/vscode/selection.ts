import * as vscode from 'vscode';
import { buildContextWindow, isUsefulSelection } from '../core/selection';
import type { AppSettings, SelectionContext } from '../core/types';
import { normalizeNewlines, truncate, truncateMiddle } from '../core/text';

export interface CapturedSelection {
  context: SelectionContext;
  editor: vscode.TextEditor;
  range: vscode.Range;
}

export function captureSelection(
  editor: vscode.TextEditor | undefined,
  settings: AppSettings,
): CapturedSelection | undefined {
  if (!editor || editor.selections.length !== 1) return undefined;

  const selection = editor.selection;
  if (selection.isEmpty) return undefined;

  const rawCode = normalizeNewlines(editor.document.getText(selection));
  if (!isUsefulSelection(rawCode)) return undefined;

  const clipped = truncateMiddle(rawCode, settings.maxSelectionChars);
  const startLine = selection.start.line + 1;
  const rawEndLine = selection.end.line + 1;
  const endLine =
    selection.end.character === 0 && selection.end.line > selection.start.line
      ? rawEndLine - 1
      : rawEndLine;
  const context = buildContextWindow(
    editor.document.getText(),
    startLine,
    endLine,
    settings.contextLines,
  );
  const relative = relativeFileName(editor.document);

  return {
    editor,
    range: selection,
    context: {
      uri: editor.document.uri.toString(),
      file: relative,
      language: editor.document.languageId || 'text',
      startLine,
      endLine,
      startCharacter: selection.start.character,
      endCharacter: selection.end.character,
      documentVersion: editor.document.version,
      code: clipped.text,
      before: context.before,
      after: context.after,
      lineCount: Math.max(1, endLine - startLine + 1),
      truncated: clipped.truncated,
    },
  };
}

export async function revealSelection(selection: SelectionContext): Promise<void> {
  const uri = vscode.Uri.parse(selection.uri);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const range = new vscode.Range(
    Math.max(0, selection.startLine - 1),
    Math.max(0, selection.startCharacter),
    Math.max(0, selection.endLine - 1),
    Math.max(0, selection.endCharacter),
  );
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export function selectionView(selection: SelectionContext) {
  return {
    file: selection.file,
    language: selection.language,
    startLine: selection.startLine,
    endLine: selection.endLine,
    lineCount: selection.lineCount,
    preview: truncate(selection.code, 1200),
    truncated: selection.truncated,
  };
}

function relativeFileName(document: vscode.TextDocument): string {
  try {
    const relative = vscode.workspace.asRelativePath(document.uri, false);
    if (relative && relative !== document.uri.toString()) return relative;
  } catch {
    // Fall through to a safe basename.
  }

  if (document.uri.scheme === 'untitled') {
    return document.uri.path || 'Untitled';
  }
  const parts = document.uri.path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? document.uri.toString();
}
