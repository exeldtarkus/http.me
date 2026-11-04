import * as vscode from 'vscode';
import { isNewerMinor, whatsNewHtml } from './whatsNew';
import { errMsg } from './log';
import { log, reportError } from './output';

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

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(log());
  ctx.subscriptions.push(vscode.commands.registerCommand('httpme.whatsNew', () => openWhatsNew(ctx)));

  // aktivasi malas: dicek saat extension pertama dipakai, bukan saat VS Code start
  const version: string = ctx.extension.packageJSON.version;
  const previous = ctx.globalState.get<string>(VERSION_KEY);
  void ctx.globalState.update(VERSION_KEY, version);
  if (isNewerMinor(version, previous)) openWhatsNew(ctx);
}

export function deactivate(): void {}
