import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { startServer } from './helpers/server';
import type { ITests } from './it/index';

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
type Api = { viewOf(uri: string): { kind: string } | undefined; runningCount(): number };
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;

async function sendInNewTab(url: string): Promise<string> {
  await vscode.commands.executeCommand('httpme.newRequest');
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputCustom;
  const doc = await vscode.workspace.openTextDocument(input.uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), `GET ${url}\n`);
  await vscode.workspace.applyEdit(edit);
  void vscode.commands.executeCommand('httpme.sendRequest');
  // Send menyelesaikan {{variable}} dulu (async) sebelum masuk antrean
  for (let i = 0; i < 60 && !['running', 'queued'].includes(api().viewOf(input.uri.toString())?.kind ?? ''); i++) await wait(50);
  return input.uri.toString();
}

export const tests: ITests = {
  async 'http.me: Cancel Request membatalkan request tab aktif, Cancel All Requests sisanya'() {
    const srv = await startServer(async () => { await wait(2000); return { body: 'late' }; });
    try {
      const a = await sendInNewTab(`${srv.url}/a`);
      const b = await sendInNewTab(`${srv.url}/b`);
      assert.equal(api().runningCount(), 2);
      await vscode.commands.executeCommand('httpme.cancelRequest');
      await wait(50);
      assert.equal(api().viewOf(b)?.kind, 'cancelled', 'tab aktif (b) dibatalkan');
      assert.equal(api().viewOf(a)?.kind, 'running', 'tab lain tetap jalan');
      await vscode.commands.executeCommand('httpme.cancelAllRequests');
      await wait(50);
      assert.equal(api().viewOf(a)?.kind, 'cancelled');
      assert.equal(api().runningCount(), 0);
    } finally {
      await srv.close();
    }
  },
  async 'command Cancel Request / Cancel All Requests terdaftar'() {
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['httpme.cancelRequest', 'httpme.cancelAllRequests', 'httpme.showRunning']) assert.ok(cmds.includes(c), c);
  },
};
