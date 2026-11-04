import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers/server';
import type { ITests } from './it/index';

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const titles = async (uri: vscode.Uri) =>
  ((await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)) ?? []).map((l) => `${l.range.start.line}:${l.command?.title}`);

async function openText(content: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument({ language: 'http', content });
  await vscode.window.showTextDocument(doc);
  return doc;
}

export const tests: ITests = {
  async 'CodeLens ▶ Send per blok + ▶ Send All; Send blok menampilkan status di lens'() {
    const srv = await startServer(async (req) => ({ status: req.url === '/b' ? 201 : 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }));
    try {
      const doc = await openText(`### A\nGET ${srv.url}/a\n\n### B\nPOST ${srv.url}/b\n`);
      assert.deepEqual(await titles(doc.uri), ['0:▶ Send All (2)', '0:▶ Send', '3:▶ Send']);
      await vscode.commands.executeCommand('httpme.sendBlock', doc.uri, 1);
      await wait(100);
      const t = await titles(doc.uri);
      assert.ok(t.includes('3:▶ Send'), t.join());
      assert.ok(t.some((x) => /^3:201 Created · \d+ ms · 2 B$/.test(x)), t.join());
      assert.ok(!t.some((x) => x.startsWith('0:2')), 'blok A belum dikirim');
    } finally {
      await srv.close();
    }
  },
  async 'Send All jalan paralel; ■ Cancel All membatalkan semua blok file'() {
    const srv = await startServer(async () => { await wait(2000); return { body: 'late' }; });
    try {
      const doc = await openText(`### A\nGET ${srv.url}/a\n\n### B\nGET ${srv.url}/b\n`);
      void vscode.commands.executeCommand('httpme.sendAll', doc.uri);
      await wait(100);
      const t = await titles(doc.uri);
      assert.ok(t.includes('0:■ Cancel All'), t.join());
      assert.equal(t.filter((x) => x.endsWith('Sending…')).length, 2, 'dua blok jalan bersamaan');
      assert.equal(t.filter((x) => x.endsWith('■ Cancel')).length, 2);
      await vscode.commands.executeCommand('httpme.cancelFile', doc.uri);
      await wait(100);
      const after = await titles(doc.uri);
      assert.equal(after.filter((x) => x.endsWith('Cancelled')).length, 2, after.join());
      assert.ok(!after.includes('0:■ Cancel All'));
    } finally {
      await srv.close();
    }
  },
  async 'Send Request (Ctrl+Enter) dari editor teks: blok di kursor dikirim + response tampil di samping'() {
    const srv = await startServer(async (req) => ({ headers: { 'content-type': 'text/plain' }, body: `hit ${req.url}` }));
    const dir = join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'tmp-ctrl-enter-it');
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'two.http'); // file .http di disk seperti test-extension/get.http
      writeFileSync(file, `### A\nGET ${srv.url}/a\n\n### B\nGET ${srv.url}/b\n`);
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc);
      const ed = vscode.window.activeTextEditor!;
      ed.selection = new vscode.Selection(4, 0, 4, 0); // baris di blok B
      await vscode.commands.executeCommand('httpme.sendRequest');
      const shown = vscode.window.visibleTextEditors.find((e) => e.document.uri.path === '/Response');
      assert.ok(shown, 'response tidak dibuka');
      assert.match(shown.document.getText(), /hit \/b/);
      assert.equal(vscode.window.activeTextEditor?.document, doc, 'fokus tetap di editor .http');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      rmSync(dir, { recursive: true, force: true });
      await srv.close();
    }
  },
};
