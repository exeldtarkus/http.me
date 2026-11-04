import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ITests } from './it/index';

type Item = { file: string; label: string; source: string; exists: boolean; dirty: boolean };
type State = { type: 'scripts'; available: boolean; pre: Item[]; post: Item[]; preview: string[]; own: boolean; dirty: boolean };
type Api = { scriptsCall(uri: vscode.Uri, m: Record<string, unknown>): Promise<unknown[]> };
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const state = async (uri: vscode.Uri) => (await api().scriptsCall(uri, { type: 'scriptsGet' }))[0] as State;
const brief = (items: Item[]) => items.map((x) => `${x.source}:${x.label}${x.exists ? '' : '?'}${x.dirty ? '●' : ''}`);

export const tests: ITests = {
  async 'tab Scripts: Runs in order, edit This request (file baru, dirty), + Add script (baru / yang ada / folder), urutan, ✕, Save (.http + script)'() {
    await vscode.commands.executeCommand('httpme.whatsNew');
    const dir = join(root(), 'tmp-tab-it');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'pre-request.js'), '// folder\n');
    writeFileSync(join(dir, 'lib/b.js'), '// b\n');
    writeFileSync(join(dir, 'r.http'), 'GET http://localhost/x\n');
    const uri = vscode.Uri.file(join(dir, 'r.http'));
    const doc = await vscode.workspace.openTextDocument(uri);
    try {
      let s = await state(uri);
      assert.equal(s.available, true);
      assert.deepEqual(brief(s.pre), ['folder:./pre-request.js', 'own:This request?']);
      assert.equal(s.own, false, 'tanpa titik hijau');

      const own = s.pre[1].file;
      await api().scriptsCall(uri, { type: 'scriptEdit', path: own, text: 'console.log(1);\n' });
      s = await state(uri);
      assert.deepEqual(brief(s.pre), ['folder:./pre-request.js', 'own:This request●']);
      assert.equal(s.own, true);
      assert.deepEqual(await api().scriptsCall(uri, { type: 'scriptLoad', path: own }), [{ type: 'scriptText', path: own, text: 'console.log(1);\n' }]);
      assert.deepEqual(await api().scriptsCall(uri, { type: 'scriptLoad', path: '/etc/passwd' }), [], 'path di luar rantai ditolak');

      await api().scriptsCall(uri, { type: 'scriptAdd', kind: 'pre', choice: 'New script file…', target: 'tmp-tab-it/scripts/a.js' });
      assert.match(readFileSync(join(dir, 'scripts/a.js'), 'utf8'), /Before request/);
      await api().scriptsCall(uri, { type: 'scriptAdd', kind: 'pre', choice: 'Add existing script…', target: 'tmp-tab-it/lib/b.js' });
      assert.equal(doc.getText(), '< ./scripts/a.js\n< ./lib/b.js\nGET http://localhost/x\n');
      await api().scriptsCall(uri, { type: 'scriptMove', kind: 'pre', from: 1, to: 0 });
      assert.equal(doc.getText(), '< ./lib/b.js\n< ./scripts/a.js\nGET http://localhost/x\n');
      s = await state(uri);
      assert.deepEqual(s.preview, ['r.http: < ./lib/b.js', 'r.http: < ./scripts/a.js']);
      assert.deepEqual(brief(s.pre), ['folder:./pre-request.js', 'line:./lib/b.js', 'line:./scripts/a.js', 'own:This request●']);
      await api().scriptsCall(uri, { type: 'scriptRemove', kind: 'pre', path: join(dir, 'scripts/a.js') });
      assert.equal(doc.getText(), '< ./lib/b.js\nGET http://localhost/x\n');
      assert.ok(existsSync(join(dir, 'scripts/a.js')), '✕ tidak menghapus file');

      await api().scriptsCall(uri, { type: 'scriptAdd', kind: 'post', choice: 'Create folder script', target: 'tmp-tab-it' });
      assert.match(readFileSync(join(dir, 'post-request.js'), 'utf8'), /After response/);
      await assert.rejects(api().scriptsCall(uri, { type: 'scriptAdd', kind: 'pre', choice: 'New script file…', target: 'tmp-tab-it/lib/b.js' }), /already exists/);

      assert.ok(doc.isDirty);
      await api().scriptsCall(uri, { type: 'scriptSave' });
      assert.equal(doc.isDirty, false);
      assert.equal(readFileSync(own, 'utf8'), 'console.log(1);\n');
      assert.equal(readFileSync(join(dir, 'r.http'), 'utf8'), '< ./lib/b.js\nGET http://localhost/x\n');
      s = await state(uri);
      assert.deepEqual(brief(s.pre), ['folder:./pre-request.js', 'line:./lib/b.js', 'own:This request']);
      assert.deepEqual(brief(s.post), ['folder:./post-request.js', 'own:This request?']);
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
