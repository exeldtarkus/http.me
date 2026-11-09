import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers/server';
import type { ITests } from './it/index';

type Api = { backupNow(now?: number): Promise<{ kind: string; file: string; count: number }[]> };
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const DAY = 24 * 3600 * 1000;

export const tests: ITests = {
  async 'backup: History + request sementara (untitled) ditulis ke exports/*-backup, tidak diulang bila tidak berubah, lagi di hari baru'() {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const exportsDir = join(root, 'exports');
    const had = existsSync(exportsDir);
    const srv = await startServer(async () => ({ body: `ok-${Date.now()}` }));
    try {
      await vscode.commands.executeCommand('httpme.whatsNew');
      await vscode.commands.executeCommand('httpme.newRequest');
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputCustom;
      const doc = await vscode.workspace.openTextDocument(input.uri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), `GET ${srv.url}/backup-it-${Date.now()}\n`);
      await vscode.workspace.applyEdit(edit);
      await vscode.commands.executeCommand('httpme.sendRequest');
      await wait(800); // History ditulis berurutan setelah request selesai

      const t0 = Date.now() + 30 * DAY; // jauh di depan: hari baru dibanding backup run itest sebelumnya
      const files = await api().backupNow(t0);
      assert.ok(files.some((f) => f.kind === 'history' && /history-backup[\\/]history-.*\.json$/.test(f.file)), 'file backup History');
      const temp = files.find((f) => f.kind === 'temp' && /temp-backup[\\/]temp-.*\.json$/.test(f.file))?.file;
      assert.ok(temp, 'file backup temp');
      const b = JSON.parse(readFileSync(temp, 'utf8')) as { httpmeFormat: number; kind: string; items: { text: string }[] };
      assert.equal(b.httpmeFormat, 1);
      assert.ok(b.items.some((x) => x.text.includes('backup-it-')), 'isi tab untitled ikut');

      assert.deepEqual(await api().backupNow(t0 + 1000), [], 'tidak berubah: tidak ada backup lagi');
      edit.insert(doc.uri, new vscode.Position(0, 0), '# berubah\n');
      await vscode.workspace.applyEdit(edit);
      assert.deepEqual(await api().backupNow(t0 + 2000), [], 'berubah tapi hari sama dan tumbuh kecil: belum');
      assert.ok((await api().backupNow(t0 + DAY)).some((f) => f.kind === 'temp'), 'hari baru + berubah: backup lagi');
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await srv.close();
      if (!had) rmSync(exportsDir, { recursive: true, force: true });
      else for (const k of ['history', 'temp']) rmSync(join(exportsDir, `${k}-backup`), { recursive: true, force: true });
    }
  },
};
