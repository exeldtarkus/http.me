// panel request = custom editor di atas TextDocument .http (priority option); dirty/save/undo ditangani VS Code.
// Panel mengirim request terurai ('edit'), host menulisnya ke dokumen; perubahan dokumen dari luar dikirim balik ('state').
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { webviewPage } from './webviewPage';
import { NEW_REQUEST_TEXT, newRequestName } from './newRequest';
import { parseRequest, serializeRequest, type ParsedRequest } from './httpFile';
import { errMsg } from './log';
import { reportError } from './output';

export const REQUEST_VIEW = 'httpme.request';

/** pesan dari webview = input tak tepercaya: cek bentuknya sebelum ditulis ke dokumen */
function isRequest(v: unknown): v is ParsedRequest {
  const r = v as ParsedRequest;
  return !!r && typeof r.method === 'string' && typeof r.url === 'string' && typeof r.body === 'string' && Array.isArray(r.headers)
    && Array.isArray(r.preamble) && Array.isArray(r.disabledParams) && typeof r.followRedirects === 'boolean' && typeof r.insecure === 'boolean'
    && r.headers.every((h) => typeof h?.name === 'string' && typeof h.value === 'string' && typeof h.enabled === 'boolean')
    && r.disabledParams.every((p) => typeof p?.key === 'string' && typeof p.value === 'string')
    && r.preamble.every((l) => typeof l === 'string') && (r.timeoutSec === undefined || Number.isInteger(r.timeoutSec));
}

/** tulis request dari panel ke dokumen (seluruh isi diganti; undo VS Code tetap jalan) */
async function writeDocument(doc: vscode.TextDocument, text: string): Promise<void> {
  if (doc.getText() === text) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  await vscode.workspace.applyEdit(edit);
}

function resolve(doc: vscode.TextDocument, panel: vscode.WebviewPanel): void {
  panel.webview.options = { enableScripts: true };
  panel.webview.html = webviewPage('panel', { cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64') });
  let written: string | undefined; // teks terakhir yang ditulis dari panel: echo-nya tidak dikirim balik
  const postState = () => void panel.webview.postMessage({ type: 'state', req: parseRequest(doc.getText()) });

  const subs = [
    panel.webview.onDidReceiveMessage(async (m: { type: string; req?: unknown }) => {
      try {
        if (m.type === 'ready') postState();
        else if (m.type === 'edit' && isRequest(m.req)) {
          written = serializeRequest(m.req);
          await writeDocument(doc, written);
        }
      } catch (e) {
        reportError(`requestEditor.${m.type}`, e, `http.me: ${errMsg(e)}`);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === doc && e.contentChanges.length && doc.getText() !== written) postState();
    }),
  ];
  panel.onDidDispose(() => subs.forEach((s) => s.dispose()));
}

const provider: vscode.CustomTextEditorProvider = { resolveCustomTextEditor: resolve };

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
