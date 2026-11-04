// panel request = custom editor di atas TextDocument .http (priority option); dirty/save/undo ditangani VS Code.
// Panel mengirim request terurai ('edit'), host menulisnya ke dokumen; perubahan dokumen dari luar dikirim balik ('state').
// Request berjalan di extension host: state (running / response) per dokumen bertahan saat webview tersembunyi dilepas.
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { webviewPage } from './webviewPage';
import { NEW_REQUEST_TEXT, newRequestName } from './newRequest';
import { parseRequest, serializeRequest, toHttpRequest, type ParsedRequest } from './httpFile';
import { DEFAULT_TIMEOUT_MS, RequestError, send } from './http';
import { responseView, type ResponseView } from './response';
import { errMsg, errorLine } from './log';
import { log, reportError } from './output';

export const REQUEST_VIEW = 'httpme.request';

type View =
  | { kind: 'running'; label: string }
  | ({ kind: 'response' } & ResponseView)
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };
type DocState = { panels: Set<vscode.WebviewPanel>; view?: View; running?: AbortController };
const docs = new Map<string, DocState>();

const stateOf = (doc: vscode.TextDocument): DocState => {
  const key = doc.uri.toString();
  let s = docs.get(key);
  if (!s) docs.set(key, (s = { panels: new Set() }));
  return s;
};
const postView = (s: DocState) => s.panels.forEach((p) => void p.webview.postMessage({ type: 'view', view: s.view }));

/** pesan dari webview = input tak tepercaya: cek bentuknya sebelum ditulis ke dokumen / dikirim */
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

/** Send: request lama di dokumen yang sama dibatalkan; hasil disimpan di state dokumen */
async function sendRequest(s: DocState, parsed: ParsedRequest): Promise<void> {
  s.running?.abort();
  const ac = new AbortController();
  s.running = ac;
  const r = toHttpRequest(parsed);
  s.view = { kind: 'running', label: `${r.method} ${r.url}` };
  postView(s);
  let view: View;
  try {
    const res = await send(r, { signal: ac.signal, timeoutMs: parsed.timeoutSec !== undefined ? parsed.timeoutSec * 1000 : DEFAULT_TIMEOUT_MS });
    view = { kind: 'response', ...responseView(res, r.method) };
  } catch (e) {
    if (e instanceof RequestError && e.kind === 'cancelled') view = { kind: 'cancelled' };
    else {
      log().error(errorLine(`sendRequest ${r.method} ${r.url}`, e)); // gagal kirim tampil di panel, detail + stack di output channel
      view = { kind: 'error', message: errMsg(e) };
    }
  }
  if (s.running !== ac) return; // sudah diganti Send yang lebih baru
  s.running = undefined;
  s.view = view;
  postView(s);
}

function resolve(doc: vscode.TextDocument, panel: vscode.WebviewPanel): void {
  const s = stateOf(doc);
  s.panels.add(panel);
  panel.webview.options = { enableScripts: true };
  panel.webview.html = webviewPage('panel', { cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64') });
  let written: string | undefined; // teks terakhir yang ditulis dari panel: echo-nya tidak dikirim balik
  const postState = () => void panel.webview.postMessage({ type: 'state', req: parseRequest(doc.getText()), view: s.view });

  const subs = [
    panel.webview.onDidReceiveMessage(async (m: { type: string; req?: unknown }) => {
      try {
        if (m.type === 'ready') postState();
        else if (m.type === 'edit' && isRequest(m.req)) {
          written = serializeRequest(m.req);
          await writeDocument(doc, written);
        } else if (m.type === 'send') await sendRequest(s, isRequest(m.req) ? m.req : parseRequest(doc.getText()));
      } catch (e) {
        reportError(`requestEditor.${m.type}`, e, `http.me: ${errMsg(e)}`);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === doc && e.contentChanges.length && doc.getText() !== written) postState();
    }),
  ];
  panel.onDidDispose(() => {
    subs.forEach((x) => x.dispose());
    s.panels.delete(panel);
  });
}

/** dokumen ditutup: request yang masih jalan dibatalkan, state dilepas */
export function releaseDocument(doc: vscode.TextDocument): void {
  const s = docs.get(doc.uri.toString());
  s?.running?.abort();
  docs.delete(doc.uri.toString());
}

const provider: vscode.CustomTextEditorProvider = { resolveCustomTextEditor: resolve };

export const registerRequestEditor = (): vscode.Disposable => vscode.Disposable.from(
  vscode.window.registerCustomEditorProvider(REQUEST_VIEW, provider, { webviewOptions: { retainContextWhenHidden: false } }),
  vscode.workspace.onDidCloseTextDocument(releaseDocument),
);

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
