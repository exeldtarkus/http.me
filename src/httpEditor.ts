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
import { beautifyBody } from './beautify';
import { importCurl } from './curl';
import { defaultFileName } from './sidebarModel';
import { dropKeepIfUsed, requestFileName } from './store';
import { DEFAULT_TIMEOUT_MS, RequestError, send } from './http';
import { responseView, type ResponseView } from './response';
import { createRunner } from './runner';
import { stageText, type Stage } from './runningStatus';
import { errMsg, errorLine, maskValues } from './log';
import { log, reportError } from './output';
import type { HoverInfo } from './diagnostics';
import type { Replacement } from './varize';
import { cookieFlags } from './httpFile';
import { sendWithRelogin, sessionExpired } from './login';
import { singleFlight } from './runner';
import type { HttpResponse, SendOptions } from './http';
import { handleScriptsMessage, isChainFile, saveScripts, scriptsState, type ScriptsMessage } from './scriptsTab';
import { applyScriptRequest, overlayKV, runChain, scriptChain, toScriptRequest, type ChainResult, type ScriptContext } from './scripts';

export const REQUEST_VIEW = 'httpme.request';

/** hasil script pre / post satu Send: tab Tests & Console (console sudah di-mask) */
export type ScriptsView = { tests: ChainResult['tests']; console: ChainResult['console']; error?: string; skippedNote?: string };
type View =
  | { kind: 'queued'; label: string; position: string }
  | { kind: 'running'; label: string; /** tahap: Running pre-request.js / Following redirect 2/10 … */ stage?: string }
  | ({ kind: 'response'; scripts?: ScriptsView } & ResponseView)
  | { kind: 'error'; message: string; scripts?: ScriptsView }
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
  if (output.view && output.key !== undefined && docs.get(output.key) === s) void output.view.webview.postMessage({ type: 'view', view: s.view });
  listeners.forEach((l) => l());
};

// ---- layout response: single / two pane di panel request, atau view Response di panel bawah (samping Terminal) ----
export type Layout = 'single' | 'two' | 'panel';
export const OUTPUT_VIEW = 'httpme.response';
const LAYOUT_KEY = 'httpme.responseLayout';
let layoutState: vscode.Memento | undefined;
/** view Response panel bawah + key Send terakhir yang ditampilkannya */
const output: { view?: vscode.WebviewView; key?: string } = {};
export const getLayout = (): Layout => layoutState?.get<Layout>(LAYOUT_KEY, 'single') ?? 'single';
export async function setLayout(l: Layout): Promise<void> {
  await layoutState?.update(LAYOUT_KEY, l);
  for (const s of docs.values()) s.panels.forEach((p) => void p.webview.postMessage({ type: 'layout', layout: l }));
  void output.view?.webview.postMessage({ type: 'layout', layout: l });
  if (l === 'panel') await revealOutput();
}
async function revealOutput(): Promise<void> {
  if (output.view) output.view.show(true);
  else await vscode.commands.executeCommand(`${OUTPUT_VIEW}.focus`); // view belum pernah dibuka: resolveWebviewView yang menggambar
}
export const outputKey = (): string | undefined => output.key;
export const outputShown = (): boolean => !!output.view;
const isLayout = (x: unknown): x is Layout => x === 'single' || x === 'two' || x === 'panel';

/** Copy response body: body terpotong (> 1 MB) diambil utuh dari file cache */
async function copyBody(s: DocState, text: string): Promise<void> {
  const full = s.view?.kind === 'response' && s.view.canOpen && s.bodyFile ? await fs.readFile(s.bodyFile, 'utf8') : text;
  await vscode.env.clipboard.writeText(full);
  void vscode.window.showInformationMessage('Response body copied to the clipboard.');
}

const outputProvider: vscode.WebviewViewProvider = {
  resolveWebviewView(view) {
    output.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewPage('panel', { cspSource: view.webview.cspSource, nonce: randomBytes(16).toString('base64') });
    view.onDidDispose(() => { if (output.view === view) output.view = undefined; });
    view.webview.onDidReceiveMessage(async (m: { type?: string; layout?: unknown; text?: unknown }) => {
      const s = output.key === undefined ? undefined : docs.get(output.key);
      try {
        if (m.type === 'ready') {
          await view.webview.postMessage({ type: 'mode', responseOnly: true });
          await view.webview.postMessage({ type: 'layout', layout: getLayout() });
          await view.webview.postMessage({ type: 'view', view: s?.view });
        } else if (m.type === 'layout' && isLayout(m.layout)) await setLayout(m.layout);
        else if (m.type === 'cancel' && output.key !== undefined) runner.cancel(output.key);
        else if (m.type === 'showRunning') await vscode.commands.executeCommand('httpme.showRunning');
        else if (m.type === 'copyBody' && s && typeof m.text === 'string') await copyBody(s, m.text);
        else if (m.type === 'openBody' && s) await openBody(s);
        else if (m.type === 'saveBody' && s) await saveBody(s);
      } catch (e) {
        reportError(`responseView.${m.type}`, e, `http.me: ${errMsg(e)}`);
      }
    });
  },
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
  /** scriptVars: httpme.vars dari script pre (prioritas tertinggi) */
  resolve(r: ParsedRequest, scriptVars?: ReadonlyMap<string, string>): Promise<{ request: ParsedRequest; nulls: string[]; env?: string; secrets: string[] }>;
  /** httpme.environment untuk script: nilai Environment aktif + simpan current value; undefined = tidak ada Environment aktif */
  scriptEnv(): Promise<{ values: ReadonlyMap<string, string | null>; save(changes: ReadonlyMap<string, string | undefined>): Promise<void> } | undefined>;
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

/** cookie jar & login session: diisi extension.ts */
export type SessionHooks = {
  cookies(r: ParsedRequest): Promise<SendOptions['cookies']>;
  /** auto re-login untuk request dari dokumen `uri`; undefined = mati / tidak ada Login request / request ini login itu sendiri */
  relogin(uri: string): { login: string; pattern: string } | undefined;
  /** cookie yang akan dikirim ke URL (tab Cookies panel) */
  forUrl(url: string): Promise<{ name: string; value: string; domain: string; path: string }[]>;
  values(): Promise<string[]>;
  /** simpan cookie (header Cookie hasil import cURL) ke jar Environment aktif */
  paste(domain: string, text: string): Promise<number>;
  onChange: vscode.Event<void>;
};
let session: SessionHooks | undefined;
export function setSessionHooks(h: SessionHooks): vscode.Disposable {
  session = h;
  return h.onChange(() => { for (const [key, s] of docs) s.panels.forEach((p) => void postCookies(p, key)); });
}
/** tab Cookies panel request: cookie jar yang cocok dengan URL (variable sudah diganti) */
async function postCookies(panel: vscode.WebviewPanel, key: string): Promise<void> {
  if (!session) return;
  try {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (!doc) return;
    const parsed = parseRequest(doc.getText());
    const url = hooks ? (await hooks.resolve(parsed)).request.url : parsed.url;
    const list = cookieFlags(parsed).send ? await session.forUrl(url) : [];
    void panel.webview.postMessage({ type: 'reqCookies', list: list.map((c) => ({ ...c, value: maskCookie(c.value) })), off: !cookieFlags(parsed).send });
  } catch (e) {
    log().error(errorLine('postCookies', e));
  }
}
/** nilai cookie di UI: 4 karakter awal lalu … */
export const maskCookie = (v: string): string => (v.length <= 4 ? '••••' : `${v.slice(0, 4)}…`);

/** request login (status bar Login / auto re-login): satu login berjalan per file, request lain menunggu hasil yang sama */
const loginFlights = new Map<string, () => Promise<HttpResponse>>();
export function loginOnce(uri: string): Promise<HttpResponse> {
  let f = loginFlights.get(uri);
  if (!f) loginFlights.set(uri, (f = singleFlight(() => sendLogin(uri))));
  return f();
}
async function sendLogin(uri: string): Promise<HttpResponse> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
  const blocks = splitBlocks(doc.getText());
  const text = blocks.length > 1 ? (blocks.find((b) => parseRequest(b.text).login) ?? blocks[0]).text : doc.getText();
  let parsed = parseRequest(text);
  if (hooks) {
    const r = await hooks.resolve(parsed);
    if (r.nulls.length) throw new Error(`Login request needs ${r.nulls.join(', ')} (NULL)`);
    parsed = r.request;
  }
  const req = await toHttpRequestWithFile(parsed, (p) => readBodyFile(doc, p));
  const res = await send(req, {
    cookies: await session?.cookies({ ...parsed, noSaveCookies: false, noCookieJar: false }), followRedirects: parsed.followRedirects, insecure: parsed.insecure,
    timeoutMs: parsed.timeoutSec !== undefined ? parsed.timeoutSec * 1000 : DEFAULT_TIMEOUT_MS, onError: (where, e) => log().error(errorLine(where, e)),
  });
  log().info(`login ${loginLabel(parsed)} -> ${res.status} ${res.url.replace(/\?.*$/, '')}`);
  return res;
}
const loginLabel = (r: ParsedRequest) => `${r.method} ${r.url.replace(/\?.*$/, '')}`;

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
    && [r.noCookieJar, r.noSendCookies, r.noSaveCookies, r.login, r.noScripts, r.noPre, r.noPost].every((v) => typeof v === 'boolean')
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

/** History (diisi activity.ts): dipanggil sekali per Send yang selesai / gagal / dibatalkan */
export type HistoryHook = (e: { request: ParsedRequest; env?: string; file: string; block?: number; status?: number; ms?: number; error?: string; cancelled?: boolean }) => void;
let historyHook: HistoryHook | undefined;
export function setHistoryHook(h: HistoryHook): vscode.Disposable {
  historyHook = h;
  return new vscode.Disposable(() => { if (historyHook === h) historyHook = undefined; });
}

/** pre-request gagal / skip: request tidak dikirim */
class ScriptFailure extends Error {}

/** isi script: dokumen terbuka (termasuk yang belum disimpan) atau file */
const readScript = async (file: string) =>
  vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file)?.getText() ?? fs.readFile(file, 'utf8');

let restrictedWarned = false;
/** Restricted Mode: script tidak dijalankan, peringatan sekali per sesi */
function warnRestricted(): void {
  if (restrictedWarned) return;
  restrictedWarned = true;
  void vscode.window.showWarningMessage('Pre-request and post-response scripts are skipped in Restricted Mode. Trust this workspace to run them.', 'Manage Workspace Trust')
    .then((pick) => pick && vscode.commands.executeCommand('workbench.trust.manage'));
}

/** Send lewat runner (key = uri atau uri#blok): Send lama dengan key yang sama dibatalkan; hasil disimpan di state key */
async function sendRequest(doc: vscode.TextDocument, key: string, original: ParsedRequest): Promise<void> {
  // {{variable}} diselesaikan sebelum masuk antrean; label & log memakai teks asli (tanpa nilai)
  let parsed = original;
  let secrets: string[] = [];
  let envName: string | undefined;
  let result: { status: number; ms: number } | undefined;
  if (hooks) {
    const r = await hooks.resolve(original);
    if (r.nulls.length) {
      const pick = await nullPrompt(r.nulls, r.env);
      if (pick === 'fill') return void await vscode.commands.executeCommand('httpme.gotoVariable', r.nulls[0], 'fill');
      if (pick !== 'send') return;
    }
    parsed = r.request;
    secrets = r.secrets;
    envName = r.env;
  }
  // script: rantai dicari sebelum antre (path tidak ada = error, request tidak dikirim)
  const scriptsOn = doc.uri.scheme === 'file' && vscode.workspace.isTrusted;
  if (doc.uri.scheme === 'file' && !vscode.workspace.isTrusted) warnRestricted();
  const root = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? dirname(doc.uri.fsPath);
  const s = stateFor(key);
  let relogged = false;
  const scripts: ScriptsView = { tests: [], console: [] };
  const hasScripts = () => scripts.tests.length > 0 || scripts.console.length > 0 || !!scripts.error || !!scripts.skippedNote;
  secrets = [...secrets, ...((await session?.values()) ?? [])]; // nilai cookie ikut di-mask di log
  const label = `${original.method} ${original.url}`;
  // view Response panel bawah ikut Send terakhir
  output.key = key;
  if (output.view) output.view.description = label;
  if (getLayout() === 'panel') await revealOutput();
  const token = Symbol(label);
  s.token = token;
  s.view = { kind: 'queued', label, position: 'Queued' };
  let view: View;
  try {
    const res = await runner.run(key, label, async (signal) => {
      const setStage = (st: Stage) => { if (s.token === token && !signal.aborted) { s.view = { kind: 'running', label, stage: stageText(st) }; postView(s); } };
      if (s.token === token) { s.view = { kind: 'running', label }; postView(s); }
      const [pre, post] = scriptsOn
        ? await Promise.all([scriptChain(root, doc.uri.fsPath, original, 'pre'), scriptChain(root, doc.uri.fsPath, original, 'post')])
        : [[], []];
      let ctx: ScriptContext | undefined;
      let env: Awaited<ReturnType<VarHooks['scriptEnv']>>;
      let overlay: ReturnType<typeof overlayKV> | undefined;
      const chainOpts = { root, httpFile: doc.uri.fsPath, read: readScript, signal };
      /** satu tahap: hasil digabung ke tab Tests / Console, perubahan Environment disimpan; error = log ERROR */
      const stage = async (chain: Awaited<ReturnType<typeof scriptChain>>, what: string): Promise<ChainResult> => {
        const kind = what === 'Pre-request' ? 'pre' : 'post';
        const out = await runChain(chain, { ...chainOpts, onScript: (script) => setStage({ kind, script }) }, ctx!);
        scripts.tests.push(...out.tests);
        scripts.console.push(...out.console.map((x) => ({ ...x, text: maskValues(x.text, secrets) })));
        const changes = overlay!.take();
        if (changes.size) await env!.save(changes);
        if (out.error === 'Cancelled') throw new RequestError('Cancelled', 'cancelled');
        if (out.error) {
          scripts.error = maskValues(`${what} script failed: ${out.error}`, secrets);
          log().error(maskValues(errorLine(`sendRequest ${label} ${what} script`, new Error(out.error)), secrets));
        }
        return out;
      };
      if (pre.length || post.length) {
        env = await hooks?.scriptEnv();
        overlay = overlayKV(env?.values ?? new Map(), !!env);
        const jar = (await session?.forUrl(parsed.url)) ?? [];
        ctx = {
          request: toScriptRequest(original), environment: overlay.kv, vars: new Map(),
          cookies: { get: (n) => jar.find((c) => c.name === n)?.value, all: () => jar.map((c) => ({ name: c.name, value: c.value })) },
        };
      }
      if (pre.length) {
        const out = await stage(pre, 'Pre-request');
        if (out.error) throw new ScriptFailure(scripts.error!);
        if (out.skipped) { scripts.skippedNote = 'Request skipped by a pre-request script.'; throw new ScriptFailure(scripts.skippedNote); }
        // variable diselesaikan ulang: nilai dari httpme.vars / httpme.environment.set ikut terpakai
        const changed = applyScriptRequest(original, ctx!.request);
        const again = await hooks?.resolve(changed, ctx!.vars);
        parsed = again?.request ?? changed;
        secrets = [...secrets, ...(again?.secrets ?? [])]; // secret baru dari script ikut di-mask
      }
      if (pre.length) setStage({ kind: 'send' });
      await dropBodyFile(s);
      await fs.mkdir(bodyDir, { recursive: true, mode: 0o700 });
      const r = await toHttpRequestWithFile(parsed, (p) => readBodyFile(doc, p));
      const cookies = await session?.cookies(parsed);
      const once = () => send(r, {
        signal, bodyFile: bodyPath(key), followRedirects: parsed.followRedirects, insecure: parsed.insecure, cookies,
        onRedirect: (n) => setStage({ kind: 'redirect', n }),
        onError: (where, e) => log().error(errorLine(where, e)),
        timeoutMs: parsed.timeoutSec !== undefined ? parsed.timeoutSec * 1000 : DEFAULT_TIMEOUT_MS,
      });
      // session habis (redirect ke /login, 401/403): login sekali lalu kirim ulang, tidak pernah loop
      const rl = session?.relogin(doc.uri.toString());
      const out = await sendWithRelogin(once, (x) => sessionExpired(x, rl!.pattern), rl && (() => loginOnce(rl.login)));
      relogged = out.relogged;
      if (post.length) {
        ctx!.response = { status: out.res.status, headers: out.res.headers, body: out.res.binary ? '' : out.res.body.toString('utf8'), time: out.res.timeMs };
        await stage(post, 'Post-response');
      }
      return out.res;
    }, envName);
    if (s.token !== token) { if (res.bodyFile) await fs.rm(res.bodyFile, { force: true }); return; } // hasil Send lama: dibuang
    Object.assign(s, { bodyFile: res.bodyFile, contentType: res.headers.find(([k]) => k === 'content-type')?.[1], url: res.url, responseText: responseText(res) });
    responseChanged.fire(responseUri(key));
    result = { status: res.status, ms: res.timeMs };
    const rv = responseView(res, parsed.method);
    view = { kind: 'response', ...rv, note: relogged ? `Session expired: logged in again and resent.${rv.note ? ` ${rv.note}` : ''}` : rv.note, ...(hasScripts() ? { scripts } : {}) };
  } catch (e) {
    if (e instanceof RequestError && e.kind === 'cancelled') view = { kind: 'cancelled' };
    else if (e instanceof ScriptFailure) view = { kind: 'error', message: e.message, scripts }; // sudah dicatat ERROR di stage()
    else {
      log().error(maskValues(errorLine(`sendRequest ${label}`, e), secrets)); // gagal kirim tampil di panel, detail + stack di output channel
      view = { kind: 'error', message: maskValues(errMsg(e), secrets), ...(hasScripts() ? { scripts } : {}) };
    }
  }
  // History: request asli ({{var}} belum diganti), hasil ringkas
  const block = /#(\d+)$/.exec(key);
  historyHook?.({
    request: original, env: envName, file: doc.uri.toString(), ...(block ? { block: Number(block[1]) } : {}),
    ...(view.kind === 'response' && result ? { status: result.status, ms: result.ms }
      : view.kind === 'cancelled' ? { cancelled: true } : view.kind === 'error' ? { error: view.message } : {}),
  });
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
  let cookieTimer: ReturnType<typeof setTimeout> | undefined;
  const postState = () => void panel.webview.postMessage({
    type: 'state', req: parseRequest(doc.getText()), view: s.view, multi: splitBlocks(doc.getText()).length, dirty: doc.isDirty || doc.isUntitled,
  });

  const postMsg = (x: unknown) => void panel.webview.postMessage(x);
  const postDirty = () => postMsg({ type: 'dirty', dirty: doc.isDirty || doc.isUntitled });
  /** jumlah request lain (tab / file lain) yang sedang berjalan atau antre: loading sebaris */
  const postOthers = () => postMsg({ type: 'others', n: runner.jobs().filter((j) => j.key !== doc.uri.toString() && !j.key.startsWith(`${doc.uri.toString()}#`)).length });
  let scriptsTimer: ReturnType<typeof setTimeout> | undefined;
  /** tab Scripts: state ulang (urutan, ● belum disimpan) digabung tiap 200 ms */
  const refreshScripts = () => {
    clearTimeout(scriptsTimer);
    scriptsTimer = setTimeout(() => void scriptsState(doc).then(postMsg, (e) => log().error(errorLine('requestEditor.scriptsState', e))), 200);
  };
  const subs = [
    onRunnerChange(postOthers),
    panel.webview.onDidReceiveMessage(async (m: ScriptsMessage & { req?: unknown; name?: unknown; env?: unknown; key?: unknown; layout?: unknown }) => {
      try {
        if (await handleScriptsMessage(doc, m, postMsg)) return;
        if (m.type === 'ready') { postMsg({ type: 'layout', layout: getLayout() }); postOthers(); postState(); await postVars(panel); await postCookies(panel, doc.uri.toString()); } else if (m.type === 'varHover' && typeof m.name === 'string' && hooks) {
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
        else if (m.type === 'showRunning') await vscode.commands.executeCommand('httpme.showRunning');
        else if (m.type === 'save') {
          if (doc.isUntitled) await vscode.commands.executeCommand('httpme.saveUntitled', doc.uri);
          else await saveScripts(doc, true); // script rantai yang berubah + .http
        }
        else if (m.type === 'copyBody' && typeof m.text === 'string') await copyBody(s, m.text);
        else if (m.type === 'layout' && isLayout(m.layout)) await setLayout(m.layout);
        else if (m.type === 'beautify') {
          const r = parseRequest(doc.getText());
          const out = beautifyBody(r.body, r.bodyType);
          if (out.text !== undefined && out.text !== r.body) await writeDocument(doc, serializeRequest({ ...r, body: out.text }));
          void panel.webview.postMessage({ type: 'beautifyResult', error: out.error });
        }
        else if (m.type === 'openBody') await openBody(s);
        else if (m.type === 'saveBody') await saveBody(s);
      } catch (e) {
        reportError(`requestEditor.${m.type}`, e, `http.me: ${errMsg(e)}`);
      }
    }),
    // dokumen script rantai ini diedit di editor VS Code / Undo: isi tab Scripts & tanda ● ikut
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === doc || e.document.uri.scheme !== 'file' || !/\.js$/i.test(e.document.uri.path)) return;
      void isChainFile(doc, e.document.uri.fsPath).then((hit) => {
        if (!hit) return;
        postMsg({ type: 'scriptText', path: e.document.uri.fsPath, text: e.document.getText() });
        refreshScripts();
      }, (err) => log().error(errorLine('requestEditor.scriptSync', err)));
    }),
    vscode.workspace.onDidSaveTextDocument(() => refreshScripts()),
    vscode.workspace.onDidCreateFiles(() => refreshScripts()),
    vscode.workspace.onDidDeleteFiles(() => refreshScripts()),
    // Ctrl+S di panel menyimpan .http: script rantai yang belum disimpan ikut
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.document === doc) e.waitUntil(saveScripts(doc, false).catch((err) => reportError('requestEditor.saveScripts', err, `Could not save scripts: ${errMsg(err)}`)));
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === doc && e.contentChanges.length) { refreshScripts(); postDirty(); }
    }),
    // tombol Save panel ikut status dirty (edit dari panel sendiri tidak mengirim ulang state)
    vscode.workspace.onDidSaveTextDocument((d) => { if (d === doc) postDirty(); }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== doc || !e.contentChanges.length) return;
      if (doc.getText() !== written) postState();
      clearTimeout(cookieTimer);
      cookieTimer = setTimeout(() => void postCookies(panel, doc.uri.toString()), 300); // URL berubah: cookie yang cocok ikut
    }),
  ];
  panel.onDidDispose(() => {
    clearTimeout(cookieTimer);
    clearTimeout(scriptsTimer);
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
export const registerRequestEditor = (cacheDir: string, state: vscode.Memento): vscode.Disposable => (bodyDir = join(cacheDir, 'body'), layoutState = state, vscode.Disposable.from(
  vscode.window.registerCustomEditorProvider(REQUEST_VIEW, provider, { webviewOptions: { retainContextWhenHidden: false } }),
  vscode.window.registerWebviewViewProvider(OUTPUT_VIEW, outputProvider),
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
  const { request, summary, cookies } = importCurl(text);
  const plain = serializeRequest(request);
  let host: string | undefined;
  try { host = new URL(request.url).hostname; } catch { host = undefined; } // URL berisi {{var}}: cookie tidak bisa dipetakan ke domain
  const saveCookies = cookies && host && session ? 'Save Cookies to Jar' : undefined;
  const v = await matchValues(request, into);
  const serialized = serializeRequest(v.request);
  const note = replacedNote(v);
  const buttons = [...(saveCookies ? [saveCookies] : []), ...(note.text ? ['Undo'] : []), ...(note.other ? [`Switch to ${note.other}`] : [])];
  const handle = (target: vscode.Uri) => async (pick: string | undefined) => {
    try {
      if (saveCookies && pick === saveCookies) {
        const n = await session!.paste(host!, cookies!);
        void vscode.window.showInformationMessage(`Saved ${n} cookie${n === 1 ? '' : 's'} for ${host} to the cookie jar.`);
        return true;
      }
      return await afterReplace(pick, target, plain, note.other);
    } catch (e) {
      reportError('importCurlText', e, `http.me: ${errMsg(e)}`);
      return true;
    }
  };
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
  const fromText = vscode.window.activeTextEditor?.document === doc; // Ctrl+Enter di editor teks (bukan panel)
  // file multi-request: blok di posisi kursor
  const line = fromText ? vscode.window.activeTextEditor!.selection.active.line : 0;
  const index = Math.max(0, blocks.findIndex((b) => line >= b.start && line <= b.end));
  const key = blockKey(doc, index, blocks.length);
  await sendBlock(doc, index);
  // editor teks tidak punya panel response: tampilkan hasil di samping (fokus tetap di .http)
  if (fromText && viewOf(key)?.kind === 'response' && getLayout() !== 'panel') await showResponse(key);
}

/** Send file tertentu (status bar Login): tampil di panel / CodeLens file itu */
export async function sendUri(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const blocks = splitBlocks(doc.getText());
  if (blocks.length <= 1) return sendRequest(doc, doc.uri.toString(), parseRequest(doc.getText()));
  const i = blocks.findIndex((b) => parseRequest(b.text).login);
  await sendBlock(doc, Math.max(0, i));
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
