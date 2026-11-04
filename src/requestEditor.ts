// panel request = custom editor di atas TextDocument .http (priority option); dirty/save/undo ditangani VS Code.
// Panel mengirim request terurai ('edit'), host menulisnya ke dokumen; perubahan dokumen dari luar dikirim balik ('state').
// Request berjalan di extension host: state (running / response) per dokumen bertahan saat webview tersembunyi dilepas.
import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
type DocState = {
  panels: Set<vscode.WebviewPanel>; view?: View; running?: AbortController;
  /** file body utuh (> 1 MB / biner) di cache; dihapus saat Send berikutnya / tab ditutup */ bodyFile?: string;
  contentType?: string; url?: string;
};
const docs = new Map<string, DocState>();
/** globalStorage/httpme-cache/body (diisi registerRequestEditor) */
let bodyDir = '';

const stateOf = (doc: vscode.TextDocument): DocState => {
  const key = doc.uri.toString();
  let s = docs.get(key);
  if (!s) docs.set(key, (s = { panels: new Set() }));
  return s;
};
const bodyPath = (doc: vscode.TextDocument) => join(bodyDir, createHash('sha1').update(doc.uri.toString()).digest('hex'));

async function dropBodyFile(s: DocState): Promise<void> {
  const f = s.bodyFile;
  s.bodyFile = undefined;
  if (f) await fs.rm(f, { force: true });
}
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
async function sendRequest(doc: vscode.TextDocument, s: DocState, parsed: ParsedRequest): Promise<void> {
  s.running?.abort();
  const ac = new AbortController();
  s.running = ac;
  const r = toHttpRequest(parsed);
  s.view = { kind: 'running', label: `${r.method} ${r.url}` };
  postView(s);
  let view: View;
  try {
    await dropBodyFile(s);
    await fs.mkdir(bodyDir, { recursive: true, mode: 0o700 });
    const res = await send(r, {
      signal: ac.signal, bodyFile: bodyPath(doc), followRedirects: parsed.followRedirects, insecure: parsed.insecure,
      timeoutMs: parsed.timeoutSec !== undefined ? parsed.timeoutSec * 1000 : DEFAULT_TIMEOUT_MS,
    });
    if (s.running === ac) Object.assign(s, { bodyFile: res.bodyFile, contentType: res.headers.find(([k]) => k === 'content-type')?.[1], url: res.url });
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
        } else if (m.type === 'send') await sendRequest(doc, s, isRequest(m.req) ? m.req : parseRequest(doc.getText()));
        else if (m.type === 'cancel') s.running?.abort();
        else if (m.type === 'openBody') await openBody(s);
        else if (m.type === 'saveBody') await saveBody(s);
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

const LANG: [RegExp, string][] = [[/[/+]json\b/i, 'json'], [/[/+]xml\b/i, 'xml'], [/html/i, 'html'], [/javascript/i, 'javascript'], [/css/i, 'css']];

/** Open in editor: body utuh (> 1 MB) dari file cache, bahasa dari Content-Type */
async function openBody(s: DocState): Promise<void> {
  if (!s.bodyFile) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.bodyFile));
  const lang = LANG.find(([re]) => re.test(s.contentType ?? ''))?.[1];
  await vscode.window.showTextDocument(lang ? await vscode.languages.setTextDocumentLanguage(doc, lang) : doc, { preview: true });
}

/** Save to file: salin body utuh dari file cache; nama awal dari segmen terakhir URL */
async function saveBody(s: DocState): Promise<void> {
  if (!s.bodyFile) return;
  let name = 'response';
  try {
    name = decodeURIComponent(new URL(s.url ?? '').pathname.split('/').filter(Boolean).pop() ?? '') || name;
  } catch {
    // URL / nama tidak bisa dibaca: sengaja dilewati, pakai nama default "response"
  }
  const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(base, name.replace(/[\\/:*?"<>|]/g, '_')), saveLabel: 'Save Response Body' });
  if (!target) return;
  await vscode.workspace.fs.copy(vscode.Uri.file(s.bodyFile), target, { overwrite: true });
  void vscode.window.showInformationMessage(`Response body saved to ${target.fsPath}.`);
}

/** dokumen ditutup: request yang masih jalan dibatalkan, state & file body dilepas */
export function releaseDocument(doc: vscode.TextDocument): void {
  const s = docs.get(doc.uri.toString());
  if (!s) return;
  s.running?.abort();
  docs.delete(doc.uri.toString());
  dropBodyFile(s).catch((e) => log().error(errorLine('releaseDocument', e)));
}

const provider: vscode.CustomTextEditorProvider = { resolveCustomTextEditor: resolve };

// shortcut: file body dari sesi yang ditutup paksa (VS Code crash) tidak dibersihkan otomatis; Clear Cache menghapusnya
export const registerRequestEditor = (cacheDir: string): vscode.Disposable => (bodyDir = join(cacheDir, 'body'), vscode.Disposable.from(
  vscode.window.registerCustomEditorProvider(REQUEST_VIEW, provider, { webviewOptions: { retainContextWhenHidden: false } }),
  vscode.workspace.onDidCloseTextDocument(releaseDocument),
));

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
