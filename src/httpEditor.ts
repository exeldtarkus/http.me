// panel request = custom editor di atas TextDocument .http (priority option); dirty/save/undo ditangani VS Code.
// Panel mengirim request terurai ('edit'), host menulisnya ke dokumen; perubahan dokumen dari luar dikirim balik ('state').
// Request berjalan di extension host: state (running / response) per dokumen bertahan saat webview tersembunyi dilepas.
import * as vscode from 'vscode';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { webviewPage } from './webviewPage';
import { NEW_REQUEST_TEXT, newRequestName } from './newRequest';
import { parseRequest, serializeRequest, splitBlocks, toHttpRequestWithFile, type ParsedRequest } from './httpFile';
import { prettyJson } from './response';
import { importCurl } from './curl';
import { defaultFileName } from './sidebarModel';
import { dropKeepIfUsed, requestFileName } from './store';
import { DEFAULT_TIMEOUT_MS, RequestError, send } from './http';
import { responseView, type ResponseView } from './response';
import { createRunner } from './runner';
import { errMsg, errorLine, maskValues } from './log';
import { log, reportError } from './output';
import type { HoverInfo } from './diagnostics';
import type { Replacement } from './varize';

export const REQUEST_VIEW = 'httpme.request';

type View =
  | { kind: 'queued'; label: string; position: string }
  | { kind: 'running'; label: string }
  | ({ kind: 'response' } & ResponseView)
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };
type DocState = {
  /** panel http.me yang menampilkan state ini (hanya untuk key = uri file 1 request) */ panels: Set<vscode.WebviewPanel>; view?: View;
  /** teks response terakhir untuk "Show Response" dari CodeLens (status, header, body ≤ 1 MB) */ responseText?: string;
  /** penanda Send terakhir: hasil Send lama yang selesai belakangan tidak menimpa view */ token?: symbol;
  /** file body utuh (> 1 MB / biner) di cache; dihapus saat Send berikutnya / tab ditutup */ bodyFile?: string;
  contentType?: string; url?: string;
};
/** state per key: uri (file 1 request / panel) atau `uri#indeks` (blok file multi-request) */
const docs = new Map<string, DocState>();
/** globalStorage/httpme-cache/body (diisi registerRequestEditor) */
let bodyDir = '';

const stateFor = (key: string): DocState => {
  let s = docs.get(key);
  if (!s) docs.set(key, (s = { panels: new Set() }));
  return s;
};
const stateOf = (doc: vscode.TextDocument): DocState => stateFor(doc.uri.toString());
/** key blok: file 1 request berbagi key dengan panel */
const blockKey = (doc: vscode.TextDocument, index: number, count: number) => (count > 1 ? `${doc.uri.toString()}#${index}` : doc.uri.toString());
const keysOf = (uri: string) => [...docs.keys()].filter((k) => k === uri || k.startsWith(`${uri}#`));
// nama unik per Send: file Send lama yang dibatalkan (dihapus http.ts) tidak bentrok dengan Send baru
let sendSeq = 0;
const bodyPath = (key: string) => join(bodyDir, `${createHash('sha1').update(key).digest('hex')}-${++sendSeq}`);

async function dropBodyFile(s: DocState): Promise<void> {
  const f = s.bodyFile;
  s.bodyFile = undefined;
  if (f) await fs.rm(f, { force: true });
}
const listeners = new Set<() => void>();
const postView = (s: DocState) => {
  s.panels.forEach((p) => void p.webview.postMessage({ type: 'view', view: s.view }));
  listeners.forEach((l) => l());
};

/** antrean request semua tab (maks 6 bersamaan); posisi Queued n/m ikut diperbarui di panel */
export const runner = createRunner({
  onChange: () => {
    for (const [key, s] of docs) {
      const pos = runner.queuePosition(key);
      if (pos && s.view?.kind === 'queued') {
        s.view = { ...s.view, position: `Queued ${pos.n}/${pos.m}` };
        postView(s);
      }
    }
    listeners.forEach((l) => l());
  },
});
/** status bar / Quick Pick / CodeLens ikut perubahan antrean & hasil request */
export const onRunnerChange = (l: () => void): vscode.Disposable => (listeners.add(l), new vscode.Disposable(() => listeners.delete(l)));

/** variable {{…}}: diisi extension.ts (Environment, Globals); tanpa hook request dikirim apa adanya */
export type VarHooks = {
  resolve(r: ParsedRequest): Promise<{ request: ParsedRequest; nulls: string[]; env?: string; secrets: string[] }>;
  /** warna token di panel: nama yang punya nilai / NULL (sisanya = tidak ditemukan) */
  panelVars(): Promise<{ ok: string[]; nulls: string[]; names: string[] }>;
  hover(name: string, file: ReadonlyMap<string, string>): Promise<HoverInfo>;
  varize(r: ParsedRequest): Promise<{ request: ParsedRequest; replaced: Replacement[]; active?: string }>;
  onChange: vscode.Event<void>;
};
let hooks: VarHooks | undefined;
export function setVarHooks(h: VarHooks): vscode.Disposable {
  hooks = h;
  return h.onChange(() => { for (const s of docs.values()) s.panels.forEach((p) => void postVars(p)); });
}
async function postVars(panel: vscode.WebviewPanel): Promise<void> {
  if (!hooks) return;
  try {
    void panel.webview.postMessage({ type: 'vars', ...(await hooks.panelVars()) });
  } catch (e) {
    log().error(errorLine('postVars', e));
  }
}

export type NullChoice = 'fill' | 'send' | undefined;
/** Send dengan variable NULL: Fill in now / Send anyway / Cancel (itest mengganti dialog ini) */
let nullPrompt = async (nulls: string[], env?: string): Promise<NullChoice> => {
  const what = `${nulls.join(', ')} ${nulls.length === 1 ? 'is' : 'are'} NULL${env ? ` in Environment "${env}"` : ''}`;
  const pick = await vscode.window.showWarningMessage(`${what}.`, { modal: true, detail: 'NULL means no value yet (also not in Globals). Send anyway keeps {{name}} in the request.' }, 'Fill in now', 'Send anyway');
  return pick === 'Fill in now' ? 'fill' : pick === 'Send anyway' ? 'send' : undefined;
};
export const setNullPrompt = (fn: typeof nullPrompt): void => { nullPrompt = fn; };

/** pesan dari webview = input tak tepercaya: cek bentuknya sebelum ditulis ke dokumen / dikirim */
function isRequest(v: unknown): v is ParsedRequest {
  const r = v as ParsedRequest;
  return !!r && typeof r.method === 'string' && typeof r.url === 'string' && typeof r.body === 'string' && Array.isArray(r.headers)
    && Array.isArray(r.preamble) && Array.isArray(r.disabledParams) && typeof r.followRedirects === 'boolean' && typeof r.insecure === 'boolean'
    && r.headers.every((h) => typeof h?.name === 'string' && typeof h.value === 'string' && typeof h.enabled === 'boolean')
    && r.disabledParams.every((p) => typeof p?.key === 'string' && typeof p.value === 'string')
    && r.preamble.every((l) => typeof l === 'string') && (r.timeoutSec === undefined || Number.isInteger(r.timeoutSec))
    && Array.isArray(r.vars) && r.vars.every((v) => typeof v?.name === 'string' && typeof v.value === 'string')
    && [r.title, r.name, r.operation, r.auth].every((v) => v === undefined || typeof v === 'string')
    && [r.noCookieJar, r.login, r.noScripts, r.noPre, r.noPost].every((v) => typeof v === 'boolean')
    && [r.preScripts, r.postScripts].every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string'))
    && (r.bodyFile === undefined || typeof r.bodyFile === 'string');
}

/** tulis request dari panel ke dokumen (seluruh isi diganti; undo VS Code tetap jalan) */
async function writeDocument(doc: vscode.TextDocument, text: string): Promise<void> {
  if (doc.getText() === text) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  await vscode.workspace.applyEdit(edit);
}

/** body `< ./file`: relatif ke folder file .http; untitled belum punya folder */
async function readBodyFile(doc: vscode.TextDocument, path: string): Promise<Buffer> {
  if (doc.uri.scheme !== 'file') throw new Error(`Save the request first: the body is read from ${path}, relative to the .http file.`);
  return fs.readFile(resolvePath(dirname(doc.uri.fsPath), path));
}

/** teks response untuk dokumen "Show Response": status, header, baris kosong, body (JSON dirapikan) */
function responseText(res: Awaited<ReturnType<typeof send>>): string {
  const head = [`HTTP ${res.status} ${res.statusText}`.trimEnd(), ...res.headers.map(([k, v]) => `${k}: ${v}`)].join('\n');
  const body = res.binary ? `(binary body, ${res.size} bytes: use Save to file in the http.me panel)` : res.body.toString('utf8');
  return `${head}\n\n${prettyJson(body) ?? body}${res.truncated ? '\n\n(truncated: showing the first 1 MB)' : ''}\n`;
}

/** Send lewat runner (key = uri atau uri#blok): Send lama dengan key yang sama dibatalkan; hasil disimpan di state key */
async function sendRequest(doc: vscode.TextDocument, key: string, original: ParsedRequest): Promise<void> {
  // {{variable}} diselesaikan sebelum masuk antrean; label & log memakai teks asli (tanpa nilai)
  let parsed = original;
  let secrets: string[] = [];
  if (hooks) {
    const r = await hooks.resolve(original);
    if (r.nulls.length) {
      const pick = await nullPrompt(r.nulls, r.env);
      if (pick === 'fill') return void await vscode.commands.executeCommand('httpme.gotoVariable', r.nulls[0], 'fill');
      if (pick !== 'send') return;
    }
    parsed = r.request;
    secrets = r.secrets;
  }
  const s = stateFor(key);
  const label = `${original.method} ${original.url}`;
  const token = Symbol(label);
  s.token = token;
  s.view = { kind: 'queued', label, position: 'Queued' };
  let view: View;
  try {
    const res = await runner.run(key, label, async (signal) => {
      if (s.token === token) { s.view = { kind: 'running', label }; postView(s); }
      await dropBodyFile(s);
      await fs.mkdir(bodyDir, { recursive: true, mode: 0o700 });
      const r = await toHttpRequestWithFile(parsed, (p) => readBodyFile(doc, p));
      return send(r, {
        signal, bodyFile: bodyPath(key), followRedirects: parsed.followRedirects, insecure: parsed.insecure,
        onError: (where, e) => log().error(errorLine(where, e)),
        timeoutMs: parsed.timeoutSec !== undefined ? parsed.timeoutSec * 1000 : DEFAULT_TIMEOUT_MS,
      });
    });
    if (s.token !== token) { if (res.bodyFile) await fs.rm(res.bodyFile, { force: true }); return; } // hasil Send lama: dibuang
    Object.assign(s, { bodyFile: res.bodyFile, contentType: res.headers.find(([k]) => k === 'content-type')?.[1], url: res.url, responseText: responseText(res) });
    responseChanged.fire(responseUri(key));
    view = { kind: 'response', ...responseView(res, parsed.method) };
  } catch (e) {
    if (e instanceof RequestError && e.kind === 'cancelled') view = { kind: 'cancelled' };
    else {
      log().error(maskValues(errorLine(`sendRequest ${label}`, e), secrets)); // gagal kirim tampil di panel, detail + stack di output channel
      view = { kind: 'error', message: maskValues(errMsg(e), secrets) };
    }
  }
  if (s.token !== token) return; // sudah diganti Send yang lebih baru
  s.view = view;
  postView(s);
}

/** Send blok ke-index di dokumen (file 1 request: index 0 = seluruh file) */
export async function sendBlock(doc: vscode.TextDocument, index: number): Promise<void> {
  const blocks = splitBlocks(doc.getText());
  const b = blocks[index];
  if (!b) return;
  await sendRequest(doc, blockKey(doc, index, blocks.length), parseRequest(blocks.length > 1 ? b.text : doc.getText()));
}

/** Send All: semua blok jalan paralel (batas 6 tetap dari runner) */
export async function sendAll(doc: vscode.TextDocument): Promise<void> {
  await Promise.all(splitBlocks(doc.getText()).map((_b, i) => sendBlock(doc, i)));
}

export const cancelBlock = (doc: vscode.TextDocument, index: number) => runner.cancel(blockKey(doc, index, splitBlocks(doc.getText()).length));
/** Cancel All di file: semua blok file ini (berjalan / antre) */
export const cancelFile = (uri: string) => keysOf(uri).forEach((k) => runner.cancel(k));
export const isRunning = (key: string) => runner.jobs().some((j) => j.key === key);

// dokumen virtual "Show Response" (read-only) per key
export const RESPONSE_SCHEME = 'httpme-response';
const responseChanged = new vscode.EventEmitter<vscode.Uri>();
const responseUri = (key: string) => vscode.Uri.from({ scheme: RESPONSE_SCHEME, path: '/Response', query: encodeURIComponent(key) });
const responseProvider: vscode.TextDocumentContentProvider = {
  onDidChange: responseChanged.event,
  provideTextDocumentContent: (uri) => docs.get(decodeURIComponent(uri.query))?.responseText ?? 'No response yet.',
};
export async function showResponse(key: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(responseUri(key));
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
}

function resolve(doc: vscode.TextDocument, panel: vscode.WebviewPanel): void {
  const s = stateOf(doc);
  s.panels.add(panel);
  panel.webview.options = { enableScripts: true };
  panel.webview.html = webviewPage('panel', { cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64') });
  let written: string | undefined; // teks terakhir yang ditulis dari panel: echo-nya tidak dikirim balik
  const postState = () => void panel.webview.postMessage({
    type: 'state', req: parseRequest(doc.getText()), view: s.view, multi: splitBlocks(doc.getText()).length,
  });

  const subs = [
    panel.webview.onDidReceiveMessage(async (m: { type: string; req?: unknown; text?: unknown; name?: unknown; env?: unknown; key?: unknown }) => {
      try {
        if (m.type === 'ready') { postState(); await postVars(panel); } else if (m.type === 'varHover' && typeof m.name === 'string' && hooks) {
          const info = await hooks.hover(m.name, new Map(parseRequest(doc.getText()).vars.map((v) => [v.name, v.value])));
          void panel.webview.postMessage({ type: 'varHover', name: m.name, info });
        } else if (m.type === 'varGoto' && typeof m.name === 'string') await vscode.commands.executeCommand('httpme.gotoVariable', m.name);
        else if (m.type === 'showSecret' && typeof m.env === 'string' && typeof m.key === 'string') await vscode.commands.executeCommand('httpme.showSecret', m.env, m.key);
        else if (m.type === 'edit' && isRequest(m.req)) {
          written = serializeRequest(m.req);
          await writeDocument(doc, written);
        } else if (m.type === 'send') await sendRequest(doc, doc.uri.toString(), isRequest(m.req) ? m.req : parseRequest(doc.getText()));
        else if (m.type === 'openAsText') await openAsText(doc.uri);
        else if (m.type === 'pasteCurl' && typeof m.text === 'string') await importCurlText(m.text, doc);
        else if (m.type === 'cancel') runner.cancel(doc.uri.toString());
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

/** dokumen ditutup: request yang masih jalan dibatalkan, state & file body (semua blok) dilepas */
export function releaseDocument(doc: vscode.TextDocument): void {
  if (doc.uri.scheme === RESPONSE_SCHEME) return;
  for (const key of keysOf(doc.uri.toString())) {
    const s = docs.get(key)!;
    runner.cancel(key);
    docs.delete(key);
    dropBodyFile(s).catch((e) => log().error(errorLine('releaseDocument', e)));
  }
}

/** Open in http.me Panel: editor teks .http -> panel request (dokumen yang sama) */
export async function openInPanel(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, REQUEST_VIEW);
}

/** Open as Text: tutup panel, buka file yang sama di editor teks */
export async function openAsText(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
}

const provider: vscode.CustomTextEditorProvider = { resolveCustomTextEditor: resolve };

// shortcut: file body dari sesi yang ditutup paksa (VS Code crash) tidak dibersihkan otomatis; Clear Cache menghapusnya
export const registerRequestEditor = (cacheDir: string): vscode.Disposable => (bodyDir = join(cacheDir, 'body'), vscode.Disposable.from(
  vscode.window.registerCustomEditorProvider(REQUEST_VIEW, provider, { webviewOptions: { retainContextWhenHidden: false } }),
  vscode.workspace.onDidCloseTextDocument(releaseDocument),
  vscode.workspace.registerTextDocumentContentProvider(RESPONSE_SCHEME, responseProvider),
  responseChanged,
));

/** tab untitled -> folder tujuan Save (Add request dari folder di Collections) */
const untitledFolder = new Map<string, vscode.Uri>();

/** New Request: tab .http untitled (GET kosong atau `text`), langsung di panel request; `folder` = tujuan default saat Save */
export async function newRequest(folder?: vscode.Uri, text = NEW_REQUEST_TEXT): Promise<vscode.Uri> {
  const open = vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'untitled').map((d) => d.uri.path.split('/').pop() ?? '');
  const uri = vscode.Uri.from({ scheme: 'untitled', path: newRequestName(open) });
  await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), text);
  await vscode.workspace.applyEdit(edit);
  if (folder) untitledFolder.set(uri.toString(), folder);
  await vscode.commands.executeCommand('vscode.openWith', uri, REQUEST_VIEW);
  return uri;
}

/** folder pilihan Save: folder terikat, folder yang berisi .http / .httpmekeep, root workspace */
async function folderChoices(preferred?: vscode.Uri): Promise<vscode.Uri[]> {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
  const found = await vscode.workspace.findFiles('{**/*.http,**/.httpmekeep}', '**/node_modules/**', 5000);
  const dirs = new Map<string, vscode.Uri>();
  for (const u of [...(preferred ? [preferred] : []), ...roots, ...found.map((f) => vscode.Uri.joinPath(f, '..'))]) dirs.set(u.toString(), u);
  return [...dirs.values()];
}

export type SaveInput = { name?: string; folder?: vscode.Uri; replace?: boolean };

/** Save untitled: dialog nama (default dari path URL) + folder (default folder terikat / root) -> file .http baru, dibuka di panel */
export async function saveUntitled(uri?: vscode.Uri, input: SaveInput = {}): Promise<vscode.Uri | undefined> {
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : await activeRequestDoc();
  if (!doc) return undefined;
  if (doc.uri.scheme !== 'untitled') { await doc.save(); return doc.uri; }
  const roots = vscode.workspace.workspaceFolders ?? [];
  if (!roots.length) {
    // tanpa folder terbuka: dialog simpan bawaan VS Code
    await vscode.commands.executeCommand('workbench.action.files.saveAs', doc.uri);
    return undefined;
  }
  const bound = untitledFolder.get(doc.uri.toString());
  let folder = input.folder;
  if (!folder) {
    const choices = await folderChoices(bound);
    const pick = await vscode.window.showQuickPick(choices.map((u) => ({ label: vscode.workspace.asRelativePath(u, roots.length > 1) || u.path.split('/').pop()!, u })),
      { title: 'Save request as a new .http file', placeHolder: 'Folder' });
    folder = pick?.u;
  }
  if (!folder) return undefined;
  let name = input.name;
  for (;;) {
    name ??= await vscode.window.showInputBox({
      title: 'Save request as a new .http file', prompt: `File name in ${vscode.workspace.asRelativePath(folder, roots.length > 1)}`,
      value: defaultFileName(parseRequest(doc.getText()).url),
      validateInput: (v) => { const n = requestFileName(v); return typeof n === 'string' ? undefined : n.error; },
    });
    if (name === undefined) return undefined;
    const valid = requestFileName(name);
    if (typeof valid !== 'string') throw new Error(valid.error);
    const target = vscode.Uri.joinPath(folder, valid);
    const taken = await Promise.resolve(vscode.workspace.fs.stat(target)).then(() => true, () => false); // stat gagal = nama masih bebas
    if (taken && !input.replace) {
      const pick = await vscode.window.showWarningMessage(`${valid} already exists.`, { modal: true }, 'Replace', 'Choose Another Name');
      if (pick === 'Choose Another Name') { name = undefined; continue; }
      if (pick !== 'Replace') return undefined;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(doc.getText(), 'utf8'));
    if (target.scheme === 'file') await dropKeepIfUsed(vscode.Uri.joinPath(target, '..').fsPath);
    untitledFolder.delete(doc.uri.toString());
    await closeUntitled(doc.uri);
    await vscode.commands.executeCommand('vscode.openWith', target, REQUEST_VIEW);
    return target;
  }
}

/** tutup tab untitled tanpa dialog simpan (isinya sudah ditulis ke file) */
async function closeUntitled(uri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => (t.input as { uri?: vscode.Uri } | undefined)?.uri?.toString() === uri.toString());
  for (const t of tabs) {
    await vscode.window.tabGroups.close(t, true).then(undefined, async () => {
      // close menolak karena dirty: fokus tab lalu revert + close
      await vscode.commands.executeCommand('vscode.openWith', uri, REQUEST_VIEW);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });
  }
}

/** setting httpme.import.matchEnvironment: always / ask / never */
const matchMode = () => vscode.workspace.getConfiguration('httpme').get<string>('import.matchEnvironment', 'always');

/** nilai yang sama dengan nilai Environment → {{VARIABLE}}; loading di kolom URL panel selama mencocokkan */
async function matchValues(req: ParsedRequest, panelsOf?: vscode.TextDocument): Promise<{ request: ParsedRequest; replaced: Replacement[]; active?: string }> {
  const none = { request: req, replaced: [] as Replacement[] };
  if (!hooks || matchMode() === 'never') return none;
  const panels = panelsOf ? [...(docs.get(panelsOf.uri.toString())?.panels ?? [])] : [];
  panels.forEach((p) => void p.webview.postMessage({ type: 'matching', on: true }));
  try {
    const v = await hooks.varize(req);
    if (!v.replaced.length) return none;
    if (matchMode() === 'ask') {
      const pick = await vscode.window.showInformationMessage(`Replace ${v.replaced.length} value${v.replaced.length === 1 ? '' : 's'} with variables (${v.replaced.map((r) => r.name).join(', ')})?`, 'Replace', 'Keep Values');
      if (pick !== 'Replace') return none;
    }
    return v;
  } finally {
    panels.forEach((p) => void p.webview.postMessage({ type: 'matching', on: false }));
  }
}

/** notifikasi penggantian: daftar variable + Undo + Switch to <env> (nilai dari Environment yang tidak aktif) */
function replacedNote(v: { replaced: Replacement[]; active?: string }): { text: string; other?: string } {
  if (!v.replaced.length) return { text: '' };
  const other = v.replaced.find((r) => r.env !== undefined && r.env !== v.active)?.env;
  return { text: ` Replaced ${v.replaced.length} value${v.replaced.length === 1 ? '' : 's'} with variables: ${v.replaced.map((r) => r.name).join(', ')}.`, other };
}

/** tombol notifikasi setelah paste / Replace Values with Variables */
async function afterReplace(pick: string | undefined, target: vscode.Uri, original: string, other?: string): Promise<boolean> {
  if (pick === 'Undo') {
    await writeDocument(await vscode.workspace.openTextDocument(target), original);
    return true;
  }
  if (other && pick === `Switch to ${other}`) { await vscode.commands.executeCommand('httpme.setActiveEnvironment', other); return true; }
  return false;
}

/**
 * paste cURL di panel / Import from Clipboard: tab untitled diisi langsung; tab tersimpan -> tab Untitled baru
 * + tombol "Replace current request instead" (WorkspaceEdit ke file asli, bisa Undo)
 */
export async function importCurlText(text: string, into?: vscode.TextDocument): Promise<vscode.Uri> {
  const { request, summary } = importCurl(text);
  const plain = serializeRequest(request);
  const v = await matchValues(request, into);
  const serialized = serializeRequest(v.request);
  const note = replacedNote(v);
  const buttons = [...(note.text ? ['Undo'] : []), ...(note.other ? [`Switch to ${note.other}`] : [])];
  const handle = (target: vscode.Uri) => (pick: string | undefined) => afterReplace(pick, target, plain, note.other)
    .catch((e) => { reportError('importCurlText', e, `http.me: ${errMsg(e)}`); return true; });
  if (into?.uri.scheme === 'untitled') {
    await writeDocument(into, serialized);
    void vscode.window.showInformationMessage(summary + note.text, ...buttons).then(handle(into.uri));
    return into.uri;
  }
  const folder = into ? vscode.Uri.joinPath(into.uri, '..') : undefined;
  const created = await newRequest(folder, serialized);
  if (into) {
    void vscode.window.showInformationMessage(summary + note.text, 'Replace current request instead', ...buttons).then(async (pick) => {
      if (await handle(created)(pick)) return;
      if (pick !== 'Replace current request instead') return;
      try {
        await writeDocument(into, serialized);
        await closeUntitled(created);
        await vscode.commands.executeCommand('vscode.openWith', into.uri, REQUEST_VIEW);
      } catch (e) {
        reportError('importCurlText.replace', e, `Replace failed: ${errMsg(e)}`);
      }
    });
  } else void vscode.window.showInformationMessage(summary + note.text, ...buttons).then(handle(created));
  return created;
}

/** command Replace Values with Variables: request di tab aktif (1 request per file) */
export async function replaceValuesWithVariables(uri?: vscode.Uri): Promise<number> {
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : await activeRequestDoc();
  if (!doc) { void vscode.window.showInformationMessage('Open a .http request first.'); return 0; }
  if (splitBlocks(doc.getText()).length > 1) throw new Error('Replace Values with Variables works on files with one request.');
  if (!hooks) return 0;
  const original = doc.getText();
  const v = await hooks.varize(parseRequest(original));
  if (!v.replaced.length) { void vscode.window.showInformationMessage('No value matches an Environment variable.'); return 0; }
  await writeDocument(doc, serializeRequest(v.request));
  const note = replacedNote(v);
  void vscode.window.showInformationMessage(note.text.trim(), 'Undo', ...(note.other ? [`Switch to ${note.other}`] : []))
    .then((pick) => afterReplace(pick, doc.uri, original, note.other))
    .then(undefined, (e) => reportError('replaceValuesWithVariables', e, `http.me: ${errMsg(e)}`));
  return v.replaced.length;
}

/** dokumen request di tab aktif: panel http.me atau editor teks .http */
async function activeRequestDoc(): Promise<vscode.TextDocument | undefined> {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === REQUEST_VIEW) return vscode.workspace.openTextDocument(input.uri);
  const doc = vscode.window.activeTextEditor?.document;
  return doc && /\.http$/i.test(doc.uri.path) ? doc : undefined;
}

/** command Send Request: kirim request di tab aktif (tetap jalan walau tab lalu disembunyikan) */
export async function sendActive(): Promise<void> {
  const doc = await activeRequestDoc();
  if (!doc) return void vscode.window.showInformationMessage('Open a .http request to send it.');
  const blocks = splitBlocks(doc.getText());
  if (blocks.length <= 1) return sendRequest(doc, doc.uri.toString(), parseRequest(doc.getText()));
  // file multi-request: blok di posisi kursor
  const line = vscode.window.activeTextEditor?.document === doc ? vscode.window.activeTextEditor.selection.active.line : 0;
  const index = Math.max(0, blocks.findIndex((b) => line >= b.start && line <= b.end));
  await sendBlock(doc, index);
}

/** command Cancel Request: batalkan request tab aktif (berjalan / antre) */
export async function cancelActive(): Promise<void> {
  const doc = await activeRequestDoc();
  if (doc) cancelFile(doc.uri.toString());
}

/** jalur yang sama dengan edit dari panel: request -> teks .http -> WorkspaceEdit (dipakai itest lewat exports) */
export async function applyPanelEdit(uri: vscode.Uri, req: ParsedRequest): Promise<void> {
  if (!isRequest(req)) throw new Error('Invalid request');
  await writeDocument(await vscode.workspace.openTextDocument(uri), serializeRequest(req));
}

/** state tampilan per dokumen (dipakai itest lewat exports extension) */
export const viewOf = (key: string): View | undefined => docs.get(key)?.view;
