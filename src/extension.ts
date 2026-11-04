import * as vscode from 'vscode';
import { isNewerMinor, whatsNewHtml } from './whatsNew';
import { clearCacheFlow } from './cache';
import { errMsg } from './log';
import { log, reportError } from './output';
import { newRequest, registerRequestEditor } from './requestEditor';

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

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(log());
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.whatsNew', () => openWhatsNew(ctx)));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.clearCache', () => clearCacheCommand(ctx)));
  ctx.subscriptions.push(registerRequestEditor(vscode.Uri.joinPath(ctx.globalStorageUri, 'httpme-cache').fsPath));
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.newRequest', () =>
    newRequest().catch((e) => reportError('newRequest', e, `New Request failed: ${errMsg(e)}`))));

  // aktivasi malas: dicek saat extension pertama dipakai, bukan saat VS Code start
  const version: string = ctx.extension.packageJSON.version;
  const previous = ctx.globalState.get<string>(VERSION_KEY);
  void ctx.globalState.update(VERSION_KEY, version);
  if (isNewerMinor(version, previous)) openWhatsNew(ctx);
}

export function deactivate(): void {}
