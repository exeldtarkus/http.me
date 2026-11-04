import * as vscode from 'vscode';
import { isNewerMinor, whatsNewHtml } from './whatsNew';
import { clearCacheFlow } from './cache';
import { errMsg } from './log';
import { log, reportError } from './output';
import { applyPanelEdit, importCurlText, saveUntitled, type SaveInput, cancelActive, cancelBlock, cancelFile, newRequest, openAsText, openInPanel, registerRequestEditor, runner, sendActive, sendAll, sendBlock, showResponse, viewOf } from './httpEditor';
import { HTTP_FILES, RequestLenses } from './codelens';
import { registerSidebar, type Sidebar } from './sidebar';
import { registerActivity } from './activity';

// versi terakhir yang pernah aktif, untuk What's New sekali per minor
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
export type HttpmeApi = { viewOf: typeof viewOf; runningCount: () => number; applyPanelEdit: typeof applyPanelEdit; sidebar: Sidebar };

export function activate(ctx: vscode.ExtensionContext): HttpmeApi {
  ctx.subscriptions.push(log());
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.whatsNew', () => openWhatsNew(ctx)));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.clearCache', () => clearCacheCommand(ctx)));
  ctx.subscriptions.push(registerRequestEditor(vscode.Uri.joinPath(ctx.globalStorageUri, 'httpme-cache').fsPath));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.newRequest', () =>
    newRequest().catch((e) => reportError('newRequest', e, `New Request failed: ${errMsg(e)}`))));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.sendRequest', () =>
    sendActive().catch((e) => reportError('sendRequest', e, `Send failed: ${errMsg(e)}`))));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.cancelRequest', () =>
    cancelActive().catch((e) => reportError('cancelRequest', e, `Cancel failed: ${errMsg(e)}`))));
  ctx.subscriptions.push(registerActivity());
  const { sidebar, disposable: sidebarDisposable } = registerSidebar(ctx);
  ctx.subscriptions.push(sidebarDisposable);
  const run = (name: string, fn: () => Promise<unknown> | unknown) => Promise.resolve().then(fn).catch((e) => reportError(name, e, `http.me: ${errMsg(e)}`));
  const docOf = (uri: vscode.Uri) => vscode.workspace.openTextDocument(uri);
  // uri tab aktif: editor teks maupun custom editor
  const activeUri = () => (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined)?.uri;
  const lenses = new RequestLenses();
  ctx.subscriptions.push(
    lenses,
    vscode.languages.registerCodeLensProvider(HTTP_FILES, lenses),
    vscode.commands.registerCommand('httpme.sendBlock', (uri: vscode.Uri, i: number) => run('sendBlock', async () => sendBlock(await docOf(uri), i))),
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
    vscode.commands.registerCommand('httpme.openInPanel', (uri?: vscode.Uri) => run('openInPanel', async () => {
      const target = uri ?? activeUri();
      if (target) await openInPanel(target);
    })),
  );

  // aktivasi malas: dicek saat extension pertama dipakai, bukan saat VS Code start
  const version: string = ctx.extension.packageJSON.version;
  const previous = ctx.globalState.get<string>(VERSION_KEY);
  void ctx.globalState.update(VERSION_KEY, version);
  if (isNewerMinor(version, previous)) openWhatsNew(ctx);
  return { viewOf, runningCount: () => runner.jobs().length, applyPanelEdit, sidebar };
}

export function deactivate(): void {}
