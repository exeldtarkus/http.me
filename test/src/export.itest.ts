import * as assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ExportChoice } from '../../src/exportCommand';
import type { ExportResult } from '../../src/exportRun';
import type { ITests } from './it/index';

type Api = { exportApply(root: string, c: ExportChoice): Promise<ExportResult> };
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
const ws = () => vscode.workspace.workspaceFolders![0].uri;

async function collection(): Promise<string> {
  const dir = vscode.Uri.joinPath(ws(), 'ItestExport');
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, 'Users'));
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'Users', 'List.http'), Buffer.from('### List\nGET https://a.test/users/42\n'));
  return dir.fsPath;
}

export const tests: ITests = {
  async 'command Export… terdaftar'() {
    await vscode.commands.executeCommand('httpme.showLog'); // aktifkan extension (aktivasi malas)
    assert.ok((await vscode.commands.getCommands(true)).includes('httpme.export'));
  },
  async 'export Postman lalu OpenAPI ke exports/ lewat jalur command'() {
    const root = await collection();
    const out = join(ws().fsPath, 'exports');
    try {
      const p = await api().exportApply(root, { format: 'postman', outFile: join(out, 'ItestExport.postman_collection.json') });
      assert.equal(p.requests, 1);
      assert.equal(JSON.parse(readFileSync(join(out, 'ItestExport.postman_collection.json'), 'utf8')).item[0].name, 'Users');
      const o = await api().exportApply(root, { format: '3.0.3', outFile: join(out, 'ItestExport.openapi.json') });
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(o.files[0], 'utf8')).paths), ['/users/{userId}']);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
  async 'collection tanpa .http: 0 request'() {
    const empty = vscode.Uri.joinPath(ws(), 'ItestExportEmpty');
    await vscode.workspace.fs.createDirectory(empty);
    const out = join(ws().fsPath, 'exports', 'x.json');
    try {
      const r = await api().exportApply(empty.fsPath, { format: 'postman', outFile: out });
      assert.equal(r.requests, 0);
    } finally {
      rmSync(join(ws().fsPath, 'exports'), { recursive: true, force: true });
      rmSync(empty.fsPath, { recursive: true, force: true });
    }
    assert.equal(existsSync(out), false);
  },
};
