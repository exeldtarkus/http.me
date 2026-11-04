import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ITests } from './it/index';

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const ws = () => vscode.workspace.workspaceFolders![0].uri;

async function until<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, ms = 3000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`timeout: ${what}`);
}

export const tests: ITests = {
  async 'path < / > : link, diagnostics file tidak ada, Quick Fix Create file, autocomplete .js'() {
    await vscode.commands.executeCommand('httpme.whatsNew'); // aktivasi
    const dir = vscode.Uri.joinPath(ws(), 'tmp-scripts-it');
    await vscode.workspace.fs.createDirectory(dir);
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'sign.js'), Buffer.from('// sign\n'));
      const http = vscode.Uri.joinPath(dir, 'r.http');
      await vscode.workspace.fs.writeFile(http, Buffer.from('< ./sign.js\n< ./nope.js\nGET http://localhost/\n\n> ./post.js\n'));
      const doc = await vscode.workspace.openTextDocument(http);
      await vscode.window.showTextDocument(doc);

      const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', http);
      assert.deepEqual(links.filter((l) => l.target?.scheme === 'file').map((l) => l.target!.path.split('/').pop()).sort(), ['nope.js', 'post.js', 'sign.js']);

      const diags = await until('diagnostics', () => {
        const d = vscode.languages.getDiagnostics(http).filter((x) => x.source === 'http.me' && /not found/.test(x.message));
        return d.length === 2 ? d : undefined;
      });
      assert.deepEqual(diags.map((d) => d.message).sort(), [
        'Script file not found: ./nope.js (tmp-scripts-it/nope.js)',
        'Script file not found: ./post.js (tmp-scripts-it/post.js)',
      ]);

      const post = diags.find((d) => d.message.includes('post.js'))!;
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', http, post.range);
      const create = actions.find((a) => a.title === 'Create file ./post.js');
      assert.ok(create?.command, actions.map((a) => a.title).join());
      await vscode.commands.executeCommand(create.command.command, ...(create.command.arguments ?? []));
      const text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'post.js'))).toString('utf8');
      assert.match(text, /After response/);
      await until('diagnostics post.js hilang', () => vscode.languages.getDiagnostics(http).filter((x) => /not found/.test(x.message)).length === 1);

      const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', http, new vscode.Position(1, 2));
      const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
      assert.ok(labels.includes('./sign.js') && labels.includes('./post.js'), labels.join());
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.workspace.fs.delete(dir, { recursive: true });
    }
  },
  async 'script milik request ikut rename .http; dikosongkan + disimpan = dihapus'() {
    await vscode.commands.executeCommand('httpme.whatsNew');
    const dir = vscode.Uri.joinPath(ws(), 'tmp-own-it');
    const f = (n: string) => vscode.Uri.joinPath(dir, n);
    const has = (u: vscode.Uri) => vscode.workspace.fs.stat(u).then(() => true, () => false);
    await vscode.workspace.fs.createDirectory(dir);
    try {
      await vscode.workspace.fs.writeFile(f('a.http'), Buffer.from('GET http://localhost/\n'));
      await vscode.workspace.fs.writeFile(f('a.pre-request.js'), Buffer.from('// x\n'));
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(f('a.http'), f('b.http'));
      assert.ok(await vscode.workspace.applyEdit(edit));
      await until('a.pre-request.js dipindah', async () => (await has(f('b.pre-request.js'))) && !(await has(f('a.pre-request.js'))));

      const doc = await vscode.workspace.openTextDocument(f('b.pre-request.js'));
      const ed = await vscode.window.showTextDocument(doc);
      await ed.edit((b) => b.delete(new vscode.Range(0, 0, doc.lineCount, 0)));
      await doc.save();
      await until('script kosong dihapus', async () => !(await has(f('b.pre-request.js'))));
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.workspace.fs.delete(dir, { recursive: true });
    }
  },
  async 'CodeLens "applies to N requests" di pre-request.js; Add Script Typings menulis httpme.d.ts + jsconfig.json'() {
    await vscode.commands.executeCommand('httpme.whatsNew');
    const dir = vscode.Uri.joinPath(ws(), 'tmp-lens-it');
    const dts = vscode.Uri.joinPath(ws(), 'httpme.d.ts');
    const jsconfig = vscode.Uri.joinPath(ws(), 'jsconfig.json');
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'pre-request.js'), Buffer.from('// x\n'));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'a.http'), Buffer.from('### a\nGET http://x\n\n### b\nGET http://y\n'));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'sub/b.http'), Buffer.from('GET http://z\n'));
      await vscode.workspace.openTextDocument(vscode.Uri.joinPath(dir, 'pre-request.js')); // provider butuh dokumen terbuka
      const lenses = await until('lens', async () => {
        const l = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', vscode.Uri.joinPath(dir, 'pre-request.js'));
        return l?.length ? l : undefined;
      });
      assert.deepEqual(lenses.map((l) => l.command?.title), ['applies to 3 requests']);

      await vscode.commands.executeCommand('httpme.addScriptTypings');
      const text = Buffer.from(await vscode.workspace.fs.readFile(dts)).toString('utf8');
      assert.match(text, /declare const httpme: Httpme;/);
      assert.deepEqual(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(jsconfig)).toString('utf8')).compilerOptions.lib, ['es2022']);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      for (const u of [dir, dts, jsconfig]) await vscode.workspace.fs.delete(u, { recursive: true }).then(undefined, () => undefined);
    }
  },
};
