import * as vscode from 'vscode';
import { isNewerVersion, whatsNewHtml } from './whatsNew';
import { clearCacheFlow } from './cache';
import { errMsg, errorLine } from './log';
import { log, reportError } from './output';
import { applyPanelEdit, handleAuthMessage, importCurlText, saveUntitled, setAuthHooks, setOAuthStore, handleSnippet, copyBlockSnippet, type SaveInput, cancelActive, cancelBlock, cancelFile, getLayout, setLayout, outputKey, outputShown, newRequest, openAsText, openInPanel, activeBlock, registerRequestEditor, runner, quickRun, sendActive, sendAll, sendBlock, showResponse, viewOf } from './httpEditor';
import { HTTP_FILES, RequestLenses } from './codelens';
import { registerSidebar, type Sidebars } from './sidebar';
import { backupNow, registerBackup, type BackupResult } from './backupCommand';
import { historyAction, registerActivity, statusBar, type HistoryAction } from './activity';
import { listHistory } from './history';
import { Environments } from './envState';
import { compareView, focusOf, envOp, registerEnvironmentEditor } from './environmentEditor';
import { registerEnvironmentCommands } from './environmentCommands';
import { registerVariables } from './variables';
import { registerScriptLinks } from './scriptLinks';
import { handleScriptsMessage, type ScriptsMessage } from './scriptsTab';
import { replaceValuesWithVariables, setNullPrompt, setVarHooks } from './httpEditor';
import { hoverInfo } from './diagnostics';
import { resolveRequest } from './vars';
import { varize, varizeCandidates } from './varize';
import { Cookies, registerCookieCommands, registerLoginStatus } from './cookies';
import { cookieFlags, parseRequest, splitBlocks } from './httpFile';
import { importApply, registerImport } from './importCommand';
import { exportApply } from './exportCommand';
import { registerDashboard } from './dashboardCommand';
import { curlPasteToHttp } from './curl';
import { sendUri, setSessionHooks } from './httpEditor';

// versi terakhir yang pernah aktif, untuk What's New tiap versi naik
const VERSION_KEY = 'httpme.version';
let whatsNewPanel: vscode.WebviewPanel | undefined;

function openWhatsNew(ctx: vscode.ExtensionContext): void {
  try {
    if (whatsNewPanel) return whatsNewPanel.reveal();
    whatsNewPanel = vscode.window.createWebviewPanel('httpme.whatsNew', "What's New: http.me", vscode.ViewColumn.Active, {});
    whatsNewPanel.onDidDispose(() => (whatsNewPanel = undefined));
    whatsNewPanel.webview.html = whatsNewHtml(whatsNewPanel.webview.cspSource, ctx.extension.packageJSON.version);
  } catch (e) {
    reportError('openWhatsNew', e, `Could not open What's New: ${errMsg(e)}`);
  }
}

/** Clear Cache: hapus globalStorage/httpme-cache/ (dibuat ulang saat dipakai) + ttlCache di memory */
async function clearCacheCommand(ctx: vscode.ExtensionContext): Promise<void> {
  const dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'httpme-cache').fsPath;
  try {
    const mb = await clearCacheFlow(dir, async (size) => (await vscode.window.showWarningMessage(`Clear the http.me cache (${size} MB)?`, {
      modal: true, detail: 'Removes cached history and response bodies. Collections (.http files) and Environments are kept.',
    }, 'Clear Cache')) === 'Clear Cache');
    if (mb === undefined) return;
    log().info(`clear cache: ${mb} MB removed (${dir})`);
    void vscode.window.showInformationMessage(`http.me cache cleared (${mb} MB).`);
  } catch (e) {
    reportError('clearCache', e, `Clear Cache failed: ${errMsg(e)}`);
  }
}

/** API extension: hanya untuk itest (membaca state request di extension host) */
export type HttpmeApi = {
  viewOf: typeof viewOf; runningCount: () => number; applyPanelEdit: typeof applyPanelEdit; sidebar: Sidebars;
  envs: Environments; cookies: Cookies; envOp: typeof envOp; focusOf: typeof focusOf; compareView: typeof compareView; setNullPrompt: typeof setNullPrompt;
  /** pesan tab Scripts seperti dari webview; kembalikan pesan balasan host */
  scriptsCall(uri: vscode.Uri, m: ScriptsMessage): Promise<unknown[]>;
  /** pesan tab Authorization seperti dari webview; kembalikan pesan balasan host */
  authCall(uri: vscode.Uri, m: Record<string, unknown>): Promise<unknown[]>;
  /** panel Code snippet seperti dari webview (tanpa Copy: dialog konfirmasi secret bersifat modal); kembalikan pesan balasan host */
  snippetCall(uri: vscode.Uri, opts: unknown, request?: import('./httpFile').ParsedRequest): Promise<unknown[]>;
  statusBar: typeof statusBar;
  /** layout response (single / two pane / panel bawah) + view Response panel bawah */
  layout: { get: typeof getLayout; set: typeof setLayout; outputKey: typeof outputKey; outputShown: typeof outputShown };
  /** backup History / temp ke exports/ sekarang (itest); `now` mengatur jam */ backupNow(now?: number): Promise<BackupResult[]>;
  history: { list(): ReturnType<typeof listHistory>; action(id: string, a: HistoryAction): Promise<void> };
  /** tab request aktif panel file multi-request */ activeBlock: typeof activeBlock;
  /** export lewat jalur yang sama dengan command Export… (itest) */ exportApply(root: string, choice: import('./exportCommand').ExportChoice): Promise<import('./exportRun').ExportResult>;
  /** tulis rencana import lewat antrean import (itest) */ importApply(plan: import('./importCommon').ImportPlan, dir: string): Promise<import('./importer').ApplyResult>;
};
async function scriptsCall(uri: vscode.Uri, m: ScriptsMessage): Promise<unknown[]> {
  const out: unknown[] = [];
  await handleScriptsMessage(await vscode.workspace.openTextDocument(uri), m, (x) => out.push(x));
  return out;
}
async function authCall(uri: vscode.Uri, m: Record<string, unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  await handleAuthMessage(await vscode.workspace.openTextDocument(uri), m, (x) => out.push(x));
  return out;
}

async function convertPastedCurl(doc: vscode.TextDocument, offset: number, pasted: string): Promise<void> {
  const http = curlPasteToHttp(pasted);
  if (http === undefined) return;
  const range = new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + pasted.length));
  if (doc.getText(range) !== pasted) return; // dokumen sudah berubah lagi
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, http.replace(/\n$/, ''));
  if (await vscode.workspace.applyEdit(edit)) void vscode.window.showInformationMessage('Converted pasted cURL to an HTTP request. Undo (Ctrl+Z) restores the cURL text.');
}

/** lens "Convert to .http format": baris curl pertama sampai akhir blok diganti request .http (judul ### / komentar di atasnya tetap) */
async function convertBlockCurl(doc: vscode.TextDocument, index: number): Promise<void> {
  const b = splitBlocks(doc.getText())[index];
  if (!b) return;
  const lines = b.text.split('\n');
  const at = lines.findIndex((l) => /^\s*curl(\.exe)?\s/i.test(l));
  const http = at < 0 ? undefined : curlPasteToHttp(lines.slice(at).join('\n'));
  if (http === undefined) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(b.start + at, 0, b.end, doc.lineAt(b.end).text.length), http.replace(/\n$/, ''));
  await vscode.workspace.applyEdit(edit);
}

async function snippetCall(uri: vscode.Uri, opts: unknown, request?: import('./httpFile').ParsedRequest): Promise<unknown[]> {
  const out: unknown[] = [];
  const doc = await vscode.workspace.openTextDocument(uri);
  await handleSnippet(doc, 'snippet', opts, request ?? parseRequest(doc.getText()), (x) => out.push(x));
  return out;
}

function authEnvironmentHooks(envs: Environments): vscode.Disposable {
  return setAuthHooks({
    async moveToSecret(preferredName, value) {
      const active = envs.active;
      if (!active || !(await envs.names()).includes(active)) throw new Error('Select an active Environment before moving a secret.');
      const vars = await envs.vars(active);
      let name = preferredName;
      for (let suffix = 2; vars.some((x) => x.key === name); suffix++) name = `${preferredName}_${suffix}`;
      await envs.write(active, [...vars, { key: name, value: null, secret: true }]);
      await envs.setSecret(active, name, value);
      return name;
    },
  });
}

/** Environment → hook variable panel request / Send / paste */
function variableHooks(envs: Environments): vscode.Disposable {
  return setVarHooks({
    onChange: envs.onDidChange,
    async resolve(r, scriptVars, file) {
      const scopes = await envs.scopes(r.vars, file);
      const res = resolveRequest(r, scriptVars?.size ? [{ source: 'script', values: scriptVars }, ...scopes] : scopes);
      return { ...res, env: envs.active, secrets: await envs.secretValues() };
    },
    async scriptEnv() {
      const name = envs.active;
      if (!name) return undefined;
      const secret = new Set((await envs.vars(name)).filter((x) => x.secret).map((x) => x.key));
      return {
        values: await envs.values(name),
        // current value lokal / SecretStorage, file Environment tidak diubah
        async save(changes) {
          for (const [k, v] of changes) await (secret.has(k) ? envs.setSecret(name, k, v) : envs.setCurrent(name, k, v));
        },
      };
    },
    async panelVars() {
      const c = await envs.context();
      const active = c.environments.find((e) => e.name === c.active);
      const ok = new Set<string>();
      const nulls = new Set<string>();
      for (const values of [c.globals, active?.values ?? new Map()]) for (const [k, v] of values) (v === null ? nulls : ok).add(k);
      ok.forEach((k) => nulls.delete(k));
      return { ok: [...ok], nulls: [...nulls], names: [...new Set([...ok, ...nulls])].sort((a, b) => a.localeCompare(b)) };
    },
    async hover(name, file) { return hoverInfo(name, await envs.context(), file); },
    async varize(r) {
      const c = await envs.context();
      return { ...varize(r, varizeCandidates(c.active, c.environments, c.globals)), active: c.active };
    },
  });
}

export function activate(ctx: vscode.ExtensionContext): HttpmeApi {
  ctx.subscriptions.push(log());
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.whatsNew', () => openWhatsNew(ctx)));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.setRequestTimeout', () => run('setRequestTimeout', async () => {
    const cfg = vscode.workspace.getConfiguration('httpme');
    const v = await vscode.window.showInputBox({
      title: 'Request Timeout', prompt: 'Seconds before a request times out (default 600 = 10 minutes). A "# @timeout" line in a request overrides this.',
      value: String(cfg.get<number>('request.timeout', 600)), validateInput: (t) => (Number(t) > 0 ? undefined : 'Enter a number greater than 0'),
    });
    if (v !== undefined) await cfg.update('request.timeout', Number(v), vscode.ConfigurationTarget.Global);
  })));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.clearCache', () => clearCacheCommand(ctx)));
  ctx.subscriptions.push(registerRequestEditor(vscode.Uri.joinPath(ctx.globalStorageUri, 'httpme-cache').fsPath, ctx.globalState));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.newRequest', () =>
    newRequest().catch((e) => reportError('newRequest', e, `New Request failed: ${errMsg(e)}`))));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.quickRun', () =>
    quickRun().catch((e) => reportError('quickRun', e, `Quick Run failed: ${errMsg(e)}`))));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.sendRequest', () =>
    sendActive().catch((e) => reportError('sendRequest', e, `Send failed: ${errMsg(e)}`))));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.cancelRequest', () =>
    cancelActive().catch((e) => reportError('cancelRequest', e, `Cancel failed: ${errMsg(e)}`))));
  const historyDir = vscode.Uri.joinPath(ctx.globalStorageUri, 'httpme-cache', 'history').fsPath;
  ctx.subscriptions.push(registerActivity(historyDir), registerBackup(ctx, historyDir));
  const envs = new Environments(ctx);
  setOAuthStore(ctx.secrets);
  ctx.subscriptions.push(envs.watch(), registerEnvironmentEditor(envs), authEnvironmentHooks(envs));
  const cookies = new Cookies(ctx, envs);
  const { sidebar, disposable: sidebarDisposable } = registerSidebar(ctx, envs, cookies);
  ctx.subscriptions.push(cookies, registerLoginStatus(cookies, envs), registerCookieCommands(cookies, async (uri) => {
    await sendUri(uri);
    const v = viewOf(uri.toString());
    if (v?.kind === 'response') void vscode.window.showInformationMessage(`Login: ${v.status}. ${v.cookies.length ? `${v.cookies.length} cookie${v.cookies.length === 1 ? '' : 's'} saved.` : 'No cookie was set.'}`);
    else if (v?.kind === 'error') reportError('login', new Error(v.message), `Login failed: ${v.message}`);
  }), setSessionHooks({
    onChange: cookies.onDidChange,
    cookies: (r) => cookies.sendOptions(cookieFlags(r)),
    relogin: (uri) => {
      const login = cookies.loginRequest();
      const cfg = vscode.workspace.getConfiguration('httpme.login');
      if (!login || login === uri || !cfg.get<boolean>('autoRelogin', true)) return undefined;
      return { login, pattern: cfg.get<string>('expiredPattern', '/login') };
    },
    forUrl: (url) => cookies.forUrl(url),
    values: () => cookies.values(),
    paste: (domain, text) => cookies.paste(cookies.env, domain, text),
  }));
  ctx.subscriptions.push(sidebarDisposable, registerEnvironmentCommands(envs, () => sidebar.redraw()), registerVariables(envs), variableHooks(envs), registerScriptLinks(), ...registerImport(envs, () => sidebar.refresh()), registerDashboard(envs, cookies, historyDir));
  void envs.checkKeys().catch((e) => log().error(errorLine('checkKeys', e)));
  const run = (name: string, fn: () => Promise<unknown> | unknown) => Promise.resolve().then(fn).catch((e) => reportError(name, e, `http.me: ${errMsg(e)}`));
  const docOf = (uri: vscode.Uri) => vscode.workspace.openTextDocument(uri);
  // uri tab aktif: editor teks maupun custom editor
  const activeUri = () => (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined)?.uri;
  const lenses = new RequestLenses();
  ctx.subscriptions.push(
    lenses,
    vscode.languages.registerCodeLensProvider(HTTP_FILES, lenses),
    vscode.commands.registerCommand('httpme.sendBlock', (uri: vscode.Uri, i: number) => run('sendBlock', async () => sendBlock(await docOf(uri), i))),
    vscode.commands.registerCommand('httpme.copySnippet', (uri: vscode.Uri, i: number) => run('copySnippet', async () => copyBlockSnippet(await docOf(uri), i))),
    // curl dipaste ke editor teks .http -> otomatis jadi request (Ctrl+Z mengembalikan teks curl asli)
    vscode.workspace.onDidChangeTextDocument((e) => {
      const c = e.contentChanges[0];
      if (e.document.languageId !== 'http' || e.reason !== undefined || e.contentChanges.length !== 1 || c.text.length < 8) return;
      void convertPastedCurl(e.document, c.rangeOffset, c.text).catch((err) => log().error(errorLine('pasteCurl', err)));
    }),
    vscode.commands.registerCommand('httpme.convertCurl', (uri: vscode.Uri, i: number) => run('convertCurl', async () => convertBlockCurl(await docOf(uri), i))),
    vscode.commands.registerCommand('httpme.sendAll', (uri: vscode.Uri) => run('sendAll', async () => sendAll(await docOf(uri)))),
    vscode.commands.registerCommand('httpme.cancelBlock', (uri: vscode.Uri, i: number) => run('cancelBlock', async () => cancelBlock(await docOf(uri), i))),
    vscode.commands.registerCommand('httpme.cancelFile', (uri: vscode.Uri) => cancelFile(uri.toString())),
    vscode.commands.registerCommand('httpme.showResponse', (key: string) => run('showResponse', () => showResponse(key))),
    vscode.commands.registerCommand('httpme.showLog', () => log().show(true)),
    vscode.commands.registerCommand('httpme.saveUntitled', (uri?: vscode.Uri, input?: SaveInput) =>
      run('saveUntitled', async () => { await saveUntitled(uri instanceof vscode.Uri ? uri : undefined, input); sidebar.refresh(); })),
    vscode.commands.registerCommand('httpme.importFromClipboard', () => run('importFromClipboard', async () => importCurlText(await vscode.env.clipboard.readText()))),
    vscode.commands.registerCommand('httpme.openAsText', (uri?: vscode.Uri) => run('openAsText', async () => {
      const target = uri ?? activeUri();
      if (target) await openAsText(target);
    })),
    vscode.commands.registerCommand('httpme.replaceValuesWithVariables', (uri?: vscode.Uri) => run('replaceValuesWithVariables', () => replaceValuesWithVariables(uri))),
    vscode.commands.registerCommand('httpme.openInPanel', (uri?: vscode.Uri, index?: number) => run('openInPanel', async () => {
      const target = uri ?? activeUri();
      if (target) await openInPanel(target, typeof index === 'number' ? index : undefined);
    })),
  );

  // aktivasi malas: dicek saat extension pertama dipakai, bukan saat VS Code start
  const version: string = ctx.extension.packageJSON.version;
  const previous = ctx.globalState.get<string>(VERSION_KEY);
  void ctx.globalState.update(VERSION_KEY, version);
  if (isNewerVersion(version, previous)) openWhatsNew(ctx);
  return { viewOf, runningCount: () => runner.jobs().length, applyPanelEdit, sidebar, envs, cookies, envOp, focusOf, compareView, setNullPrompt, scriptsCall, authCall, snippetCall,
    statusBar, layout: { get: getLayout, set: setLayout, outputKey, outputShown }, backupNow: (now) => backupNow(historyDir, ctx.globalState, now), history: { list: () => listHistory(historyDir), action: (id, a) => historyAction(historyDir, id, a) }, activeBlock,
    importApply: (plan, dir) => importApply(plan, dir, envs, () => sidebar.refresh()),
    exportApply: (root, choice) => exportApply(root, choice, envs, historyDir) };
}

export function deactivate(): void {}
