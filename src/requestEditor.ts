// panel request = custom editor di atas TextDocument .http (priority option); dirty/save/undo ditangani VS Code.
// shortcut: Fase 0 baru menampilkan isi file; form method/URL/Params/Headers dibuat di Fase 1
import * as vscode from 'vscode';
import { esc, webviewPage } from './webviewPage';
import { NEW_REQUEST_TEXT, newRequestName } from './newRequest';

export const REQUEST_VIEW = 'httpme.request';

const render = (webview: vscode.Webview, doc: vscode.TextDocument) =>
  webviewPage('request', { cspSource: webview.cspSource, title: esc(doc.uri.path.split('/').pop() ?? ''), text: esc(doc.getText()) });

const provider: vscode.CustomTextEditorProvider = {
  resolveCustomTextEditor(doc, panel) {
    panel.webview.html = render(panel.webview, doc);
    // render ulang saat isi berubah; webview tersembunyi dilepas (retainContextWhenHidden: false) dan di-resolve ulang saat tampil
    const sub = vscode.workspace.onDidChangeTextDocument((e) => { if (e.document === doc) panel.webview.html = render(panel.webview, doc); });
    panel.onDidDispose(() => sub.dispose());
  },
};

export const registerRequestEditor = (): vscode.Disposable =>
  vscode.window.registerCustomEditorProvider(REQUEST_VIEW, provider, { webviewOptions: { retainContextWhenHidden: false } });

/** New Request: tab .http untitled berisi GET kosong, langsung di panel request */
export async function newRequest(): Promise<void> {
  const open = vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'untitled').map((d) => d.uri.path.split('/').pop() ?? '');
  const uri = vscode.Uri.from({ scheme: 'untitled', path: newRequestName(open) });
  await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), NEW_REQUEST_TEXT);
  await vscode.workspace.applyEdit(edit);
  await vscode.commands.executeCommand('vscode.openWith', uri, REQUEST_VIEW);
}
