import * as assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { startServer } from './helpers/server';
import type { ImportPlan } from '../../src/importCommon';
import type { ApplyResult } from '../../src/importer';
import type { ITests } from './it/index';

const POSTMAN = JSON.stringify({ info: { name: 'ItestShop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'Ping', request: { method: 'GET', url: 'https://a.test/ping' } }] });
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const tabLabels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
type Api = { viewOf(uri: string): { kind: string } | undefined; runningCount(): number; importApply(plan: ImportPlan, dir: string): Promise<ApplyResult>; envs: { active: string | undefined } };
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
const plan = (name: string, n: number): ImportPlan => ({ name, format: 'postman', warnings: [], files: Array.from({ length: n }, (_, i) => ({ path: `${name}/r${i}.http`, content: `GET https://a.test/${i}\n`, warnings: [] })) });

export const tests: ITests = {
  async 'command Import, Undo Last Import, Re-import from Source terdaftar'() {
    await vscode.commands.executeCommand('httpme.showLog'); // aktifkan extension (aktivasi malas)
    const all = await vscode.commands.getCommands(true);
    for (const c of ['httpme.import', 'httpme.undoLastImport', 'httpme.reimportFromSource']) assert.ok(all.includes(c), c);
  },
  async 'Import dari Clipboard (Postman) membuka tab Import preview tanpa menulis file'() {
    const before = await vscode.workspace.findFiles('ItestShop/**');
    await vscode.env.clipboard.writeText(POSTMAN);
    void vscode.commands.executeCommand('httpme.import', 'clipboard');
    for (let i = 0; i < 50 && !tabLabels().includes('Import preview: ItestShop'); i++) await wait(100);
    assert.ok(tabLabels().includes('Import preview: ItestShop'), tabLabels().join(', '));
    assert.equal((await vscode.workspace.findFiles('ItestShop/**')).length, before.length, 'preview belum menulis file');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  },
  async 'Undo Last Import tanpa import sebelumnya = pesan, bukan error'() {
    await vscode.commands.executeCommand('httpme.undoLastImport');
  },
  async 'import tidak mengganggu Send: request jalan tetap selesai, slot request tidak terpakai, import kedua diantrekan, fokus tidak berpindah'() {
    const srv = await startServer(async () => { await wait(600); return { body: 'ok' }; });
    const dir = mkdtempSync(join(vscode.workspace.workspaceFolders![0].uri.fsPath, '.itest-import-'));
    try {
      await vscode.commands.executeCommand('httpme.newRequest');
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputCustom;
      const doc = await vscode.workspace.openTextDocument(input.uri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), `GET ${srv.url}/slow\n`);
      await vscode.workspace.applyEdit(edit);
      void vscode.commands.executeCommand('httpme.sendRequest');
      for (let i = 0; i < 60 && api().viewOf(input.uri.toString())?.kind !== 'running'; i++) await wait(50);
      assert.equal(api().viewOf(input.uri.toString())?.kind, 'running');
      const activeBefore = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
      const envBefore = api().envs.active;

      const order: string[] = [];
      const a = api().importApply(plan('A', 60), dir).then((r) => { order.push('A'); return r; });
      const b = api().importApply(plan('B', 3), dir).then((r) => { order.push('B'); return r; });
      assert.equal(api().runningCount(), 1, 'import tidak memakai slot request');
      const [ra, rb] = await Promise.all([a, b]);
      assert.deepEqual(order, ['A', 'B'], 'import kedua menunggu yang pertama');
      assert.equal(ra.created.length, 60);
      assert.equal(rb.created.length, 3);
      assert.ok(existsSync(join(dir, 'A', 'r59.http')));
      assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.label, activeBefore, 'tab aktif tidak berpindah');
      assert.equal(api().envs.active, envBefore, 'Environment aktif tidak berubah');
      for (let i = 0; i < 100 && api().viewOf(input.uri.toString())?.kind === 'running'; i++) await wait(50);
      assert.notEqual(api().viewOf(input.uri.toString())?.kind, 'cancelled', 'request yang berjalan tidak dibatalkan oleh import');
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
