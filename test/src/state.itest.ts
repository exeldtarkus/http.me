import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { startServer } from './helpers/server';
import type { ITests } from './it/index';

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
type Api = { viewOf(uri: string): { kind: string; status?: string } | undefined; layout: { set(l: string): Promise<void>; outputKey(): string | undefined } };
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;

/** tab request baru (panel) berisi `text`, kembalikan uri-nya */
async function requestTab(text: string): Promise<vscode.Uri> {
  await vscode.commands.executeCommand('httpme.newRequest');
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputCustom;
  const doc = await vscode.workspace.openTextDocument(input.uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  await vscode.workspace.applyEdit(edit);
  return input.uri;
}

export const tests: ITests = {
  async 'request tetap jalan saat tab disembunyikan; hasil tersimpan di host dan tampil lagi saat tab dibuka'() {
    const srv = await startServer(async () => { await wait(400); return { headers: { 'content-type': 'text/plain' }, body: 'late' }; });
    try {
      const uri = await requestTab(`GET ${srv.url}/slow\n`);
      void vscode.commands.executeCommand('httpme.sendRequest');
      await wait(50);
      assert.equal(api().viewOf(uri.toString())?.kind, 'running');
      // tab lain di grup yang sama: webview panel disembunyikan & dilepas (retainContextWhenHidden: false)
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: 'other' }), { preview: false });
      assert.notEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom, true);
      await wait(600);
      const view = api().viewOf(uri.toString());
      assert.equal(view?.kind, 'response');
      assert.equal(view?.status, '200 OK');
      await vscode.commands.executeCommand('vscode.openWith', uri, 'httpme.request');
      assert.equal(api().viewOf(uri.toString())?.kind, 'response', 'hasil tetap ada saat panel tampil lagi');
    } finally {
      await srv.close();
    }
  },
  async 'request lama selesai setelah pindah ke request cepat: Response panel bawah ikut menampilkan hasil request lama'() {
    const slow = await startServer(async () => { await wait(1200); return { headers: { 'content-type': 'text/plain' }, body: 'slow' }; });
    const fast = await startServer(async () => ({ headers: { 'content-type': 'text/plain' }, body: 'fast' }));
    try {
      await api().layout.set('panel');
      const a = await requestTab(`GET ${slow.url}/a\n`);
      void vscode.commands.executeCommand('httpme.sendRequest');
      await wait(100);
      const b = await requestTab(`GET ${fast.url}/b\n`);
      await vscode.commands.executeCommand('httpme.sendRequest');
      await wait(300);
      assert.equal(api().viewOf(b.toString())?.kind, 'response');
      assert.equal(api().layout.outputKey(), b.toString(), 'request cepat tampil dulu');
      assert.equal(api().viewOf(a.toString())?.kind, 'running');
      await wait(1500);
      assert.equal(api().viewOf(a.toString())?.kind, 'response');
      assert.equal(api().layout.outputKey(), a.toString(), 'request lama selesai: Response panel pindah ke hasilnya');
    } finally {
      await slow.close();
      await fast.close();
    }
  },
};
