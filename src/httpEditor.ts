// panel request = custom editor di atas TextDocument .http (priority option); dirty/save/undo ditangani VS Code.
// Panel mengirim request terurai ('edit'), host menulisnya ke dokumen; perubahan dokumen dari luar dikirim balik ('state').
// Request berjalan di extension host: state (running / response) per dokumen bertahan saat webview tersembunyi dilepas.
import * as vscode from 'vscode';
import { attachBackBar } from './backBar';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { fileBody, multipartBody } from './bodyStream';
import { accessToken, tokenKey, type OAuthToken } from './oauth2';
import { loopback, type Loopback } from './oauth2Loopback';
import { DEFAULT_SNIPPET, generateSnippet, maskSecrets, usesSecrets, type SnippetOptions } from './snippet';
import type { HttpRequest } from './http';
import { applyAuth, headerAuth, parseAuth, sendWithDigest, type AuthConfig, type AuthType } from './auth';
import { webviewPage } from './webviewPage';
import { NEW_REQUEST_TEXT, newRequestName } from './newRequest';
import { blockLabel, parseRequest, replaceBlock, serializeRequest, splitBlocks, toHttpRequestWithFile, toHttpRequest, type SendableRequest, type ParsedRequest } from './httpFile';
import { prettyJson } from './response';
import { beautifyBody } from './beautify';
import { importCurl, quickRequest } from './curl';
import { defaultFileName } from './sidebarModel';
import { dropKeepIfUsed, requestFileName } from './store';
import { RequestError, resolveTimeoutMs, send } from './http';
import { responseView, tabStatus, type ResponseView } from './response';
import { createRunner } from './runner';
import { historyView, type HistoryEntry } from './history';
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
export const getLayout = (): Layout => layoutState?.get<Layout>(LAYOUT_KEY, 'panel') ?? 'panel'; // bawaan Bottom panel, juga Send dari file .http teks
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
/** tutup panel bawah hanya bila yang terlihat adalah view Response http.me (Terminal / Output milik user tidak disentuh) */
export async function closeOutputPanel(): Promise<void> {
  if (output.view?.visible) await vscode.commands.executeCommand('workbench.action.closePanel');
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

/** tab per request file multi-request: label + status Send terakhir; [] bila file hanya 1 request */
function blockTabs(text: string, uri: string): { label: string; method: string; text: string; cls: string }[] {
  const blocks = splitBlocks(text);
  if (blocks.length < 2) return [];
  return blocks.map((b, i) => {
    const r = parseRequest(b.text);
    return { label: blockLabel(r), method: r.method, ...tabStatus(docs.get(`${uri}#${i}`)?.view) };
  });
}
const uriOfKey = (key: string) => key.replace(/#\d+$/, '');
/** view Response panel bawah: tab request bila key = blok file multi-request */
function postOutputBlocks(): void {
  if (!output.view || output.key === undefined || !/#\d+$/.test(output.key)) return void output.view?.webview.postMessage({ type: 'blocks', blocks: [], active: 0 });
  const uri = uriOfKey(output.key);
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
  if (doc) void output.view.webview.postMessage({ type: 'blocks', blocks: blockTabs(doc.getText(), uri), active: Number(output.key.slice(uri.length + 1)) });
}
/** view Response panel bawah menampilkan key ini (pilih tab request) */
function showInOutput(key: string): void {
  output.key = key;
  void output.view?.webview.postMessage({ type: 'view', view: docs.get(key)?.view ?? null }); // undefined hilang di postMessage: view lama tetap tampil
  postOutputBlocks();
}
listeners.add(postOutputBlocks);

const outputProvider: vscode.WebviewViewProvider = {
  resolveWebviewView(view) {
    output.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewPage('panel', { cspSource: view.webview.cspSource, nonce: randomBytes(16).toString('base64') });
    view.onDidDispose(() => { if (output.view === view) output.view = undefined; });
    view.webview.onDidReceiveMessage(async (m: { type?: string; layout?: unknown; text?: unknown; index?: unknown }) => {
      const s = output.key === undefined ? undefined : docs.get(output.key);
      try {
        if (m.type === 'ready') {
          await view.webview.postMessage({ type: 'mode', responseOnly: true });
          await view.webview.postMessage({ type: 'layout', layout: getLayout() });
          await view.webview.postMessage({ type: 'view', view: s?.view ?? null });
          postOutputBlocks();
        } else if (m.type === 'pickBlock' && typeof m.index === 'number' && output.key !== undefined) showInOutput(`${uriOfKey(output.key)}#${m.index}`);
        else if (m.type === 'layout' && isLayout(m.layout)) await setLayout(m.layout);
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
  /** file: path .http asal request (mencari `_variables.json` collection) */
  resolve(r: ParsedRequest, scriptVars?: ReadonlyMap<string, string>, file?: string): Promise<{ request: ParsedRequest; nulls: string[]; env?: string; secrets: string[] }>;
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
    const url = hooks ? (await hooks.resolve(parsed, undefined, doc.uri.fsPath)).request.url : parsed.url;
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
    const r = await hooks.resolve(parsed, undefined, doc.uri.fsPath);
    if (r.nulls.length) throw new Error(`Login request needs ${r.nulls.join(', ')} (NULL)`);
    parsed = r.request;
  }
  const req = await toHttpRequestWithFile(parsed, (p) => readBodyFile(doc, p));
  const res = await send(req, {
    cookies: await session?.cookies({ ...parsed, noSaveCookies: false, noCookieJar: false }), followRedirects: parsed.followRedirects, insecure: parsed.insecure,
    timeoutMs: timeoutMs(parsed.timeoutSec), onError: (where, e) => log().error(errorLine(where, e)),
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
function bodyFilePath(doc: vscode.TextDocument, path: string): string {
  if (doc.uri.scheme !== 'file') throw new Error(`Save the request first: the body is read from ${path}, relative to the .http file.`);
  return resolvePath(dirname(doc.uri.fsPath), path);
}
const readBodyFile = (doc: vscode.TextDocument, path: string): Promise<Buffer> => fs.readFile(bodyFilePath(doc, path));
const isMultipart = (headers: [string, string][]): boolean => headers.some(([n, v]) => n.toLowerCase() === 'content-type' && /^multipart\/form-data/i.test(v));

/** Request-level auth wins; otherwise inherit the first non-inherit config walking up from the request folder. */
export async function resolveRequestAuth(uri: vscode.Uri, request: ParsedRequest, resolveParent: (r: ParsedRequest) => Promise<ParsedRequest> = async (r) => r): Promise<AuthConfig> {
  const own = parseAuth(request.auth, request.headers);
  if (own.type !== 'inherit' || uri.scheme !== 'file') return own;

  let dir = dirname(uri.fsPath);
  for (;;) {
    const file = join(dir, '_auth.http');
    if (existsSync(file)) {
      const parent = await resolveParent(parseRequest(await fs.readFile(file, 'utf8')));
      const inherited = parseAuth(parent.auth, parent.headers);
      if (inherited.type !== 'inherit') return inherited;
    }
    const ancestor = dirname(dir);
    if (ancestor === dir) return own;
    dir = ancestor;
  }
}

type AuthForm = { type: AuthType; fields: Record<string, string> };
type AuthHooks = { moveToSecret(name: string, value: string): Promise<string> };
const AUTH_FIELDS: Record<AuthType, readonly string[]> = {
  inherit: [], none: [], apiKey: ['key', 'value', 'in'], basic: ['username', 'password'], bearer: ['token'],
  digest: ['username', 'password', 'retry', 'algorithm', 'qop', 'realm', 'nonce', 'nc', 'cnonce', 'opaque'],
  hawk: ['id', 'key', 'algorithm', 'user', 'nonce', 'ext', 'app', 'dlg', 'timestamp'],
  jwt: ['algorithm', 'secret', 'payload', 'header', 'add_to', 'prefix', 'secret_base64'],
  oauth1: ['consumer_key', 'consumer_secret', 'token', 'token_secret', 'signature_method', 'add_to', 'callback', 'verifier', 'timestamp', 'nonce', 'version', 'realm'],
  oauth2: ['grant', 'token_url', 'authorization_url', 'client_id', 'client_secret', 'username', 'password', 'scope', 'redirect_uri', 'code_verifier', 'refresh_token'],
  aws: ['access_key', 'secret_key', 'region', 'service', 'session_token'],
};
const AUTH_SECRET_FIELDS: Partial<Record<AuthType, readonly string[]>> = {
  apiKey: ['value'], basic: ['password'], bearer: ['token'], digest: ['password'], hawk: ['key'],
  jwt: ['secret'], oauth1: ['consumer_secret', 'token', 'token_secret'],
  oauth2: ['client_secret', 'password', 'code_verifier', 'refresh_token'], aws: ['secret_key', 'session_token'],
};
const authVariable = /^\{\{\s*[^{}]+\s*\}\}$/;
let authHooks: AuthHooks | undefined;
const authQueues = new Map<string, Promise<void>>();

export function setAuthHooks(hooks: AuthHooks): vscode.Disposable {
  authHooks = hooks;
  return { dispose: () => { if (authHooks === hooks) authHooks = undefined; } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validateAuthForm(value: unknown): AuthForm {
  if (!isRecord(value) || !exactKeys(value, ['type', 'fields']) || typeof value.type !== 'string'
    || !Object.hasOwn(AUTH_FIELDS, value.type) || !isRecord(value.fields)) {
    throw new Error('Invalid Authorization form.');
  }
  const type = value.type as AuthType;
  const fields: Record<string, string> = {};
  for (const [name, field] of Object.entries(value.fields)) {
    if (name === '__proto__' || name === 'constructor' || name === 'prototype' || !AUTH_FIELDS[type].includes(name)
      || typeof field !== 'string' || field.length > 1_000_000) {
      throw new Error('Invalid Authorization form.');
    }
    fields[name] = field;
  }
  return { type, fields };
}

function serializeAuthForm(auth: AuthForm): string {
  const fields = Object.entries(auth.fields).filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(' ');
  return `${auth.type}${fields ? ` ${fields}` : ''}`;
}

function authRequestAt(doc: vscode.TextDocument, index: number): ParsedRequest {
  const blocks = splitBlocks(doc.getText());
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) throw new Error('Invalid Authorization request index.');
  return blocks.length > 1 ? parseRequest(blocks[index].text) : parseRequest(doc.getText());
}

async function writeAuthRequest(doc: vscode.TextDocument, index: number, request: ParsedRequest): Promise<void> {
  const text = splitBlocks(doc.getText()).length > 1 ? replaceBlock(doc.getText(), index, request) : serializeRequest(request);
  await writeDocument(doc, text);
}

function requestAuthType(request: ParsedRequest): string {
  if (request.auth?.trim()) return request.auth.trim().split(/\s+/)[0].toLowerCase();
  return request.headers.some((h) => h.enabled && h.name.toLowerCase() === 'authorization') ? 'explicit' : 'inherit';
}

async function inheritedAuthSource(uri: vscode.Uri, request: ParsedRequest): Promise<string | undefined> {
  if (requestAuthType(request) !== 'inherit' || uri.scheme !== 'file') return undefined;
  const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  let dir = dirname(uri.fsPath);
  for (;;) {
    const file = join(dir, '_auth.http');
    if (existsSync(file) && requestAuthType(parseRequest(await fs.readFile(file, 'utf8'))) !== 'inherit') {
      return root ? relative(root, file) : file;
    }
    const ancestor = dirname(dir);
    if (ancestor === dir) return undefined;
    dir = ancestor;
  }
}

async function processAuthMessage(
  doc: vscode.TextDocument,
  message: Record<string, unknown>,
  post: (value: unknown) => void,
): Promise<void> {
  const index = message.index;
  if (!Number.isInteger(index) || (index as number) < 0) throw new Error('Invalid Authorization request index.');
  const request = authRequestAt(doc, index as number);
  if (message.type === 'authSourceGet') {
    if (!exactKeys(message, ['type', 'index'])) throw new Error('Invalid Authorization message.');
    post({ type: 'authSource', index, source: await inheritedAuthSource(doc.uri, request) ?? null });
    return;
  }
  const auth = validateAuthForm(message.auth);
  if (message.type === 'authChange') {
    if (!exactKeys(message, ['type', 'index', 'auth'])) throw new Error('Invalid Authorization message.');
    request.auth = serializeAuthForm(auth);
    await writeAuthRequest(doc, index as number, request);
    post({ type: 'authSaved' });
    return;
  }
  if (!exactKeys(message, ['type', 'index', 'auth', 'field', 'name']) || typeof message.field !== 'string'
    || typeof message.name !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(message.name)) {
    throw new Error('Invalid Authorization message.');
  }
  const field = message.field;
  const value = auth.fields[field];
  if (!AUTH_SECRET_FIELDS[auth.type]?.includes(field) || !value || authVariable.test(value.trim())) {
    throw new Error('This field does not contain a raw secret.');
  }
  if (!authHooks) throw new Error('Secret storage is not available.');
  const name = await authHooks.moveToSecret(message.name, value);
  auth.fields[field] = `{{${name}}}`;
  request.auth = serializeAuthForm(auth);
  await writeAuthRequest(doc, index as number, request);
  post({ type: 'authSecretMoved', field, name });
  post({ type: 'authSaved' });
}

export async function handleAuthMessage(
  doc: vscode.TextDocument,
  value: unknown,
  post: (value: unknown) => void = () => undefined,
): Promise<boolean> {
  if (!isRecord(value) || typeof value.type !== 'string' || !['authChange', 'authMoveToSecret', 'authSourceGet'].includes(value.type)) return false;
  const key = doc.uri.toString();
  const previous = authQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  authQueues.set(key, current);
  await previous;
  try {
    await processAuthMessage(doc, value, post);
    return true;
  } finally {
    release();
    if (authQueues.get(key) === current) authQueues.delete(key);
  }
}

let oauthStore: vscode.SecretStorage | undefined;
export const setOAuthStore = (store: vscode.SecretStorage): void => { oauthStore = store; };
const oauthFlights = new Map<string, Promise<OAuthToken>>();
const oauthKey = (fields: Readonly<Record<string, string>>, env?: string): string => `httpme.oauth2.${env ?? '-'}.${tokenKey(fields)}`;

/** token OAuth 2.0 per Environment di SecretStorage: dipakai ulang, refresh otomatis, satu alur browser per konfigurasi */
function oauthToken(fields: Readonly<Record<string, string>>, env: string | undefined, signal?: AbortSignal, force = false): Promise<OAuthToken> {
  const store = oauthStore;
  if (!store) throw new Error('Secret storage is not available.');
  const key = oauthKey(fields, env);
  const running = oauthFlights.get(key);
  if (running && !force) return running;
  let lb: Loopback | undefined;
  const flow = accessToken(fields, {
    now: Date.now,
    send: async (r) => { const res = await send({ ...r }, { ...(signal ? { signal } : {}), timeoutMs: timeoutMs(undefined) }); return { status: res.status, body: res.body.toString('utf8') }; },
    load: async () => {
      const raw = await store.get(key);
      try { return raw ? (JSON.parse(raw) as OAuthToken) : undefined; } catch (e) {
        log().error(errorLine('oauthToken.load', e)); // token tersimpan rusak: dibuang, ambil baru
        return undefined;
      }
    },
    save: async (t) => { if (t) await store.store(key, JSON.stringify(t)); else await store.delete(key); },
    listen: async (uri) => { lb = await loopback(uri); return lb.redirectUri; },
    authorize: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url)); return lb!.wait(signal ?? new AbortController().signal); },
  }, force).finally(() => { lb?.close(); oauthFlights.delete(key); });
  oauthFlights.set(key, flow);
  return flow;
}
const bearerScheme = (t: OAuthToken): string => (!t.token_type || /^bearer$/i.test(t.token_type) ? 'Bearer' : t.token_type);

/** tombol Get New Access Token / Clear di tab Authorization */
async function handleOAuth(doc: vscode.TextDocument, kind: 'oauth2Token' | 'oauth2Clear', index: unknown, post: (x: unknown) => void): Promise<void> {
  try {
    if (!Number.isInteger(index)) throw new Error('Invalid Authorization request index.');
    const own = authRequestAt(doc, index as number);
    const resolved = hooks ? await hooks.resolve(own, undefined, doc.uri.fsPath) : { request: own, env: undefined as string | undefined };
    const auth = await resolveRequestAuth(doc.uri, resolved.request, async (x) => (await hooks?.resolve(x, undefined, doc.uri.fsPath))?.request ?? x);
    if (auth.type !== 'oauth2') throw new Error('Choose OAuth 2.0 in the Authorization tab first.');
    if (kind === 'oauth2Clear') {
      await oauthStore?.delete(oauthKey(auth.fields, resolved.env));
      return post({ type: 'authInfo', text: 'Access token cleared.' });
    }
    const t = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'OAuth 2.0: getting an access token…', cancellable: true }, (_p, cancel) => {
      const ac = new AbortController();
      cancel.onCancellationRequested(() => ac.abort());
      return oauthToken(auth.fields, resolved.env, ac.signal, true);
    });
    post({ type: 'authInfo', text: t.expires_at ? `Access token stored (expires in ${Math.max(0, Math.round((t.expires_at - Date.now()) / 1000))} s).` : 'Access token stored.' });
  } catch (e) {
    log().error(errorLine('handleOAuth', e));
    post({ type: 'authError', message: errMsg(e) });
  }
}

const isSnippetOptions = (v: unknown): v is SnippetOptions => {
  const o = v as SnippetOptions;
  return !!o && typeof o === 'object' && ['curl', 'cmd', 'powershell'].includes(o.language)
    && ['longForm', 'resolve', 'followRedirects', 'cookies', 'disabledHeaders', 'multiLine', 'compactBody'].every((k) => typeof o[k as keyof SnippetOptions] === 'boolean');
};

/** panel Code snippet: variable / auth / cookie diselesaikan di sini; secret tampil ******** dan Copy meminta konfirmasi bila isinya memuat secret */
export async function handleSnippet(doc: vscode.TextDocument, kind: 'snippet' | 'copySnippet', opts: unknown, req: ParsedRequest, post: (x: unknown) => void): Promise<void> {
  if (!isSnippetOptions(opts)) throw new Error('Invalid snippet options.');
  let r = req;
  let secrets: string[] = [];
  if (opts.resolve && hooks) { const x = await hooks.resolve(req, undefined, doc.uri.fsPath); r = x.request; secrets = [...x.secrets]; }
  let jar: string | undefined;
  if (opts.cookies && session) {
    const list = await session.forUrl(r.url);
    jar = list.map((c) => `${c.name}=${c.value}`).join('; ') || undefined;
    secrets.push(...list.map((c) => c.value));
  }
  // auth statis (Basic / Bearer / API Key / JWT ...) ikut tampil; Digest dan error auth dilewati (snippet tetap dibuat)
  try {
    const auth = r.auth === undefined && r.headers.some((h) => h.enabled && h.name.toLowerCase() === 'authorization') ? headerAuth(r.headers) : await resolveRequestAuth(doc.uri, r);
    if (auth && auth.type !== 'digest' && auth.type !== 'oauth2') {
      const done = applyAuth(toHttpRequest(r) as HttpRequest, auth, new Map()).request;
      r = { ...r, url: done.url, headers: [...done.headers.map(([name, value]) => ({ name, value, enabled: true })), ...r.headers.filter((h) => !h.enabled)] };
      secrets.push(...done.headers.filter(([n]) => n.toLowerCase() === 'authorization').map(([, v]) => v.replace(/^\S+\s+/, '')));
    }
  } catch (e) {
    log().error(errorLine('snippet.auth', e)); // snippet tanpa header auth lebih berguna daripada tanpa snippet
  }
  const raw = generateSnippet(r, opts, { jar });
  const withSecrets = usesSecrets(raw, secrets);
  if (kind === 'snippet') return post({ type: 'snippet', text: maskSecrets(raw, secrets), secrets: withSecrets });
  let text = maskSecrets(raw, secrets);
  if (withSecrets) {
    const pick = await vscode.window.showWarningMessage('The snippet contains secret values.', { modal: true, detail: 'Copy the real values, or copy with ******** instead?' }, 'Copy with secret values', 'Copy masked');
    if (!pick) return;
    if (pick === 'Copy with secret values') text = raw;
  }
  await vscode.env.clipboard.writeText(text);
  post({ type: 'snippetCopied' });
  void vscode.window.showInformationMessage('Code snippet copied to the clipboard.');
}

/** Code snippet dari editor teks .http: pilih bahasa (cURL / cmd / PowerShell), salin dengan opsi bawaan panel */
export async function copyBlockSnippet(doc: vscode.TextDocument, index: number): Promise<void> {
  const blocks = splitBlocks(doc.getText());
  const b = blocks[index];
  if (!b) return;
  const pick = await vscode.window.showQuickPick(
    [{ label: 'cURL', language: 'curl' as const }, { label: 'cURL (cmd)', language: 'cmd' as const }, { label: 'PowerShell', language: 'powershell' as const }],
    { title: 'Code snippet: copy as', placeHolder: 'Language' });
  if (!pick) return;
  await handleSnippet(doc, 'copySnippet', { ...DEFAULT_SNIPPET, language: pick.language }, parseRequest(blocks.length > 1 ? b.text : doc.getText()), () => {});
}

/** teks response untuk dokumen "Show Response": status, header, baris kosong, body (JSON dirapikan) */
function responseText(res: Awaited<ReturnType<typeof send>>): string {
  const head = [`HTTP ${res.status} ${res.statusText}`.trimEnd(), ...res.headers.map(([k, v]) => `${k}: ${v}`)].join('\n');
  const body = res.binary ? `(binary body, ${res.size} bytes: use Save to file in the http.me panel)` : res.body.toString('utf8');
  return `${head}\n\n${prettyJson(body) ?? body}${res.truncated ? '\n\n(truncated: showing the first 1 MB)' : ''}\n`;
}

/** History (diisi activity.ts): dipanggil sekali per Send yang selesai / gagal / dibatalkan */
export type HistoryHook = (e: { request: ParsedRequest; env?: string; file: string; block?: number; status?: number; ms?: number; error?: string; cancelled?: boolean; response?: { contentType?: string; body?: string } }) => void;
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
  let result: { status: number; ms: number; contentType?: string; body?: string } | undefined;
  if (hooks) {
    const r = await hooks.resolve(original, undefined, doc.uri.fsPath);
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
        const again = await hooks?.resolve(changed, ctx!.vars, doc.uri.fsPath);
        parsed = again?.request ?? changed;
        secrets = [...secrets, ...(again?.secrets ?? [])]; // secret baru dari script ikut di-mask
      }
      if (pre.length) setStage({ kind: 'send' });
      await dropBodyFile(s);
      await fs.mkdir(bodyDir, { recursive: true, mode: 0o700 });
      let r: SendableRequest = toHttpRequest(parsed);
      // Authorization di header (tanpa # @auth) dikirim apa adanya; selain itu auth request / _auth.http terdekat
      const ownHeader = parsed.auth === undefined && parsed.headers.some((h) => h.enabled && h.name.toLowerCase() === 'authorization');
      const auth = ownHeader ? headerAuth(parsed.headers) : await resolveRequestAuth(doc.uri, parsed, async (x) => (await hooks?.resolve(x, undefined, doc.uri.fsPath))?.request ?? x);
      if (auth?.type === 'oauth2') {
        const t = await oauthToken(auth.fields, envName, signal);
        secrets = [...secrets, t.access_token]; // token ikut di-mask di log / pesan error
        r = { ...r, headers: [...r.headers.filter(([n]) => n.toLowerCase() !== 'authorization'), ['Authorization', `${bearerScheme(t)} ${t.access_token}`]] };
      } else if (auth) r = { ...r, ...applyAuth({ ...r }, auth, new Map()).request };
      // body besar di-stream dari disk: `< ./file` utuh, atau bagian file di body multipart (tanda tangan auth tidak mencakup isi file)
      if (parsed.bodyFile) r = { ...r, body: await fileBody(bodyFilePath(doc, parsed.bodyFile)) };
      else if (typeof r.body === 'string' && isMultipart(r.headers) && /^<\s+\S/m.test(r.body)) {
        r = { ...r, body: await multipartBody(r.body, r.headers.find(([n]) => n.toLowerCase() === 'content-type')![1], (p) => bodyFilePath(doc, p)) };
      }
      const cookies = await session?.cookies(parsed);
      const sendOnce = (req: typeof r) => send(req, {
        signal, bodyFile: bodyPath(key), followRedirects: parsed.followRedirects, insecure: parsed.insecure, cookies,
        onRedirect: (n) => setStage({ kind: 'redirect', n }),
        onError: (where, e) => log().error(errorLine(where, e)),
        timeoutMs: timeoutMs(parsed.timeoutSec),
      });
      const once = () => sendWithDigest(auth, r, sendOnce, async (x) => { if (x.bodyFile) await fs.rm(x.bodyFile, { force: true }); }); // body 401 dibuang: dikirim ulang
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
    result = { status: res.status, ms: res.timeMs, contentType: res.headers.find(([k]) => k === 'content-type')?.[1], body: res.binary || res.truncated ? undefined : maskValues(res.body.toString('utf8'), secrets) }; // secret di body di-mask sebelum masuk History
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
    ...(view.kind === 'response' && result ? { status: result.status, ms: result.ms, response: { ...(result.contentType ? { contentType: result.contentType } : {}), ...(result.body !== undefined ? { body: result.body } : {}) } }
      : view.kind === 'cancelled' ? { cancelled: true } : view.kind === 'error' ? { error: view.message } : {}),
  });
  if (s.token !== token) return; // sudah diganti Send yang lebih baru
  s.view = view;
  postView(s);
  // request lama yang selesai belakangan: Response panel bawah pindah ke hasilnya
  if (getLayout() === 'panel' && output.view && output.key !== key) showInOutput(key);
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
  // file multi-request: panel mengedit / mengirim blok aktif (tab request); file 1 request = key uri seperti biasa
  let active = pendingBlock.get(doc.uri.toString()) ?? 0;
  pendingBlock.delete(doc.uri.toString());
  const blockCount = () => splitBlocks(doc.getText()).length;
  const activeReq = (): ParsedRequest => {
    const b = splitBlocks(doc.getText());
    active = Math.min(active, Math.max(0, b.length - 1));
    return b.length > 1 ? parseRequest(b[active].text) : parseRequest(doc.getText());
  };
  const activeKey = () => blockKey(doc, active, blockCount());
  const cur = () => stateFor(activeKey());
  const writeActive = (r: ParsedRequest) => (blockCount() > 1 ? replaceBlock(doc.getText(), active, r) : serializeRequest(r));
  let lastView: View | undefined;
  const postState = () => {
    const req = activeReq();
    lastView = cur().view;
    void panel.webview.postMessage({ type: 'state', req, view: lastView ?? null, blocks: blockTabs(doc.getText(), doc.uri.toString()), active, dirty: doc.isDirty || doc.isUntitled });
  };
  /** tab request + view blok aktif ikut berubah saat request mana pun di file ini berjalan / selesai */
  const postBlocks = () => {
    if (blockCount() < 2) return;
    const v = cur().view;
    void panel.webview.postMessage({ type: 'blocks', blocks: blockTabs(doc.getText(), doc.uri.toString()), active, ...(v !== lastView ? { view: v ?? null } : {}) });
    lastView = v;
  };

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
  const picker = {
    pick: (index: number) => { active = index; postState(); if (getLayout() === 'panel' && cur().view) showInOutput(activeKey()); },
    get: () => active,
  };
  blockPickers.set(doc.uri.toString(), picker);
  const subs = [
    attachBackBar(panel, () => (doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined)),
    onRunnerChange(postOthers),
    onRunnerChange(postBlocks),
    panel.webview.onDidReceiveMessage(async (m: ScriptsMessage & { req?: unknown; name?: unknown; env?: unknown; key?: unknown; layout?: unknown; message?: unknown; index?: unknown; opts?: unknown }) => {
      try {
        if (await handleScriptsMessage(doc, m, postMsg)) return;
        if (await handleAuthMessage(doc, m, postMsg)) return;
        if (m.type === 'oauth2Token' || m.type === 'oauth2Clear') return await handleOAuth(doc, m.type, m.index, postMsg);
        if (m.type === 'snippet' || m.type === 'copySnippet') return await handleSnippet(doc, m.type, m.opts, isRequest(m.req) ? m.req : activeReq(), postMsg);
        if (m.type === 'ready') { postMsg({ type: 'layout', layout: getLayout() }); postOthers(); postState(); await postVars(panel); await postCookies(panel, doc.uri.toString()); } else if (m.type === 'varHover' && typeof m.name === 'string' && hooks) {
          const info = await hooks.hover(m.name, new Map(activeReq().vars.map((v) => [v.name, v.value])));
          void panel.webview.postMessage({ type: 'varHover', name: m.name, info });
        } else if (m.type === 'varGoto' && typeof m.name === 'string') await vscode.commands.executeCommand('httpme.gotoVariable', m.name);
        else if (m.type === 'showSecret' && typeof m.env === 'string' && typeof m.key === 'string') await vscode.commands.executeCommand('httpme.showSecret', m.env, m.key);
        else if (m.type === 'edit' && isRequest(m.req)) {
          written = blockCount() > 1 ? replaceBlock(doc.getText(), typeof m.index === 'number' ? m.index : active, m.req) : serializeRequest(m.req);
          await writeDocument(doc, written);
        } else if (m.type === 'send') await sendRequest(doc, activeKey(), isRequest(m.req) ? m.req : activeReq());
        else if (m.type === 'pickBlock' && typeof m.index === 'number') {
          picker.pick(m.index);
        } else if (m.type === 'sendAll') await sendAll(doc);
        else if (m.type === 'cancelAll') cancelFile(doc.uri.toString());
        else if (m.type === 'openAsText') await openAsText(doc.uri, blockCount() > 1 ? splitBlocks(doc.getText())[active]?.start : undefined);
        else if (m.type === 'pasteCurl' && typeof m.text === 'string') await importCurlText(m.text, doc);
        else if (m.type === 'cancel') runner.cancel(activeKey());
        else if (m.type === 'showRunning') await vscode.commands.executeCommand('httpme.showRunning');
        else if (m.type === 'save') {
          if (doc.isUntitled) await vscode.commands.executeCommand('httpme.saveUntitled', doc.uri);
          else await saveScripts(doc, true); // script rantai yang berubah + .http
        }
        else if (m.type === 'copyBody' && typeof m.text === 'string') await copyBody(cur(), m.text);
        else if (m.type === 'layout' && isLayout(m.layout)) await setLayout(m.layout);
        else if (m.type === 'warn' && typeof m.message === 'string') void vscode.window.showWarningMessage(m.message);
        else if (m.type === 'beautify') {
          const r = activeReq();
          const out = beautifyBody(r.body, r.bodyType);
          if (out.text !== undefined && out.text !== r.body) await writeDocument(doc, writeActive({ ...r, body: out.text }));
          void panel.webview.postMessage({ type: 'beautifyResult', error: out.error });
        }
        else if (m.type === 'openBody') await openBody(cur());
        else if (m.type === 'saveBody') await saveBody(cur());
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
    if (blockPickers.get(doc.uri.toString()) === picker) blockPickers.delete(doc.uri.toString());
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

/** panel yang terbuka per file: tab request aktif bisa dipilih dari luar (CodeLens Open in http.me per blok) */
const blockPickers = new Map<string, { pick: (index: number) => void; get: () => number }>();
/** blok pilihan untuk panel yang baru akan dibuka */
const pendingBlock = new Map<string, number>();
export const activeBlock = (uri: string): number | undefined => blockPickers.get(uri)?.get();

/** Open in http.me Panel: editor teks .http -> panel request (dokumen yang sama); index = tab request blok itu */
export async function openInPanel(uri: vscode.Uri, index?: number): Promise<void> {
  const picker = blockPickers.get(uri.toString());
  if (index !== undefined) {
    if (picker) picker.pick(index);
    else pendingBlock.set(uri.toString(), index);
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, REQUEST_VIEW);
}

/** Open as Text: tutup panel, buka file yang sama di editor teks; line = kursor di blok request itu (file multi-request) */
export async function openAsText(uri: vscode.Uri, line?: number): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  const ed = vscode.window.activeTextEditor;
  if (line === undefined || ed?.document.uri.toString() !== uri.toString()) return;
  ed.selection = new vscode.Selection(line, 0, line, 0);
  ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

const provider: vscode.CustomTextEditorProvider = { resolveCustomTextEditor: resolve };

// shortcut: file body dari sesi yang ditutup paksa (VS Code crash) tidak dibersihkan otomatis; Clear Cache menghapusnya
export const registerRequestEditor = (cacheDir: string, state: vscode.Memento): vscode.Disposable => (bodyDir = join(cacheDir, 'body'), layoutState = state, vscode.Disposable.from(
  vscode.window.registerCustomEditorProvider(REQUEST_VIEW, provider, { webviewOptions: { retainContextWhenHidden: false } }),
  vscode.window.registerWebviewViewProvider(OUTPUT_VIEW, outputProvider),
  // VS Code bisa menutup TextDocument tab yang tersembunyi; selama tab-nya masih ada, request & response jangan dilepas
  vscode.workspace.onDidCloseTextDocument((d) => {
    const key = d.uri.toString();
    if (!vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => (t.input as { uri?: vscode.Uri } | undefined)?.uri?.toString() === key))) releaseDocument(d);
  }),
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
const timeoutMs = (requestSec: number | undefined) => resolveTimeoutMs(requestSec, vscode.workspace.getConfiguration('httpme').get<number>('request.timeout'));
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

/** Quick Run: curl / URL dari input box -> tab .http untitled (belum disimpan) lalu langsung dikirim */
export async function quickRun(): Promise<void> {
  const clip = (await vscode.env.clipboard.readText()).trim();
  const text = await vscode.window.showInputBox({
    title: 'Quick Run', prompt: 'Paste a curl command, or enter a URL (GET) or "METHOD URL"',
    placeHolder: 'https://example.com', value: /^(curl\s|https?:\/\/)/i.test(clip) ? clip : '', ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v.trim()) return undefined;
      try { quickRequest(v); return undefined; } catch (e) { return errMsg(e); } // pesan tampil di input box, bukan error sistem
    },
  });
  if (!text?.trim()) return;
  await sendUri(await newRequest(undefined, serializeRequest(quickRequest(text))));
}

/** klik entri History: request-nya dibuka di tab baru (untitled) beserta response yang tersimpan, juga di Response panel bawah */
export async function openHistoryEntry(e: HistoryEntry): Promise<void> {
  const key = (await newRequest(undefined, e.text)).toString();
  const s = stateFor(key);
  s.view = historyView(e);
  postView(s);
  if (getLayout() === 'panel') { await revealOutput(); showInOutput(key); }
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
