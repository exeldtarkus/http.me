import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ITests } from './it/index';
import { startServer } from './helpers/server';

type EnvVar = { key: string; value: string | null; secret?: boolean; enabled?: boolean };
type Node = { kind: string; name?: string };
type Api = {
  sidebar: { getChildren(n?: Node): Promise<Node[]>; getTreeItem(n: Node): Promise<vscode.TreeItem> };
  envs: {
    active: string | undefined; write(name: string, vars: EnvVar[]): Promise<void>; vars(name: string): Promise<EnvVar[]>; secret(env: string, key: string): Thenable<string | undefined>;
    current(name: string): Record<string, string>; checkKeys(): Promise<string>; sync(): Promise<string[]>; setActive(name: string | undefined): Promise<void>;
  };
  envOp(doc: vscode.TextDocument, op: Record<string, unknown>, ask?: boolean): Promise<void>;
  focusOf(uri: vscode.Uri): { key: string; mode: string } | undefined;
  compareView(): Promise<{ keys: string[]; columns: { name: string; vars: Record<string, unknown> }[] }>;
  setNullPrompt(fn: (nulls: string[], env?: string) => Promise<'fill' | 'send' | undefined>): void;
  viewOf(key: string): { kind: string; status?: string } | undefined;
};
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const dir = () => join(root(), '.httpme', 'environments');
const envUri = (n: string) => vscode.Uri.file(join(dir(), `${n}.json`));
const fileVars = (n: string) => (JSON.parse(readFileSync(join(dir(), `${n}.json`), 'utf8')) as { variables: EnvVar[] }).variables;
const cmd = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(id, ...args);

async function until<T>(fn: () => T | Promise<T>, what: string, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await wait(50);
  }
}

/** dev + uat dengan key sama; dev aktif */
async function setup(): Promise<void> {
  mkdirSync(dir(), { recursive: true });
  await api().envs.write('dev', [{ key: 'baseUrl', value: 'https://dev.example.com/api' }, { key: 'apiKey', value: null }, { key: 'path', value: 'echo' }]);
  await api().envs.write('uat', [{ key: 'baseUrl', value: 'https://uat.example.com/api' }, { key: 'apiKey', value: 'uat-key' }, { key: 'path', value: 'echo' }]);
  await api().envs.setActive('dev');
}
async function cleanup(): Promise<void> {
  await cmd('workbench.action.closeAllEditors');
  await api().envs.setActive(undefined);
  await api().envs.write('', []); // Globals ada di user-data test (bertahan antar run)
  rmSync(join(root(), '.httpme'), { recursive: true, force: true });
  api().setNullPrompt(async () => undefined);
}

export const tests: ITests = {
  async 'Sidebar Environments: No Environment / daftar (aktif ✓, NULL) / Globals; New, Set Active, Next/Previous, Rename, Duplicate, Delete, Import Postman'() {
    try {
      await cmd('httpme.showEnvironments');
      assert.deepEqual((await api().sidebar.getChildren()).map((n) => n.kind), ['enone', 'eempty', 'eempty', 'eglobals'], 'kosong: No environments + Create Environment');
      await cmd('httpme.newEnvironment', 'dev');
      await api().envs.write('dev', [{ key: 'baseUrl', value: 'https://dev' }, { key: 'apiKey', value: null }]);
      await cmd('httpme.newEnvironment', 'uat');
      assert.deepEqual(fileVars('uat'), [{ key: 'baseUrl', value: null }, { key: 'apiKey', value: null }], 'Environment baru: semua key NULL');
      const kids = await api().sidebar.getChildren();
      assert.deepEqual(kids.map((n) => n.name ?? n.kind), ['enone', 'dev', 'uat', 'eglobals']);
      assert.equal((await api().sidebar.getTreeItem(kids[2])).description, '2 NULL');
      await cmd('httpme.setActiveEnvironment', 'uat');
      assert.equal(api().envs.active, 'uat');
      assert.equal((await api().sidebar.getTreeItem(kids[2])).description, 'active · 2 NULL');
      await cmd('httpme.nextEnvironment');
      assert.equal(api().envs.active, 'dev');
      await cmd('httpme.previousEnvironment');
      assert.equal(api().envs.active, 'uat');

      await cmd('httpme.renameEnvironment', 'uat', 'stage');
      await until(() => existsSync(join(dir(), 'stage.json')) && !existsSync(join(dir(), 'uat.json')), 'rename');
      assert.equal(api().envs.active, 'stage', 'Environment aktif ikut di-rename');
      await cmd('httpme.duplicateEnvironment', 'stage', 'qa');
      assert.deepEqual(fileVars('qa'), fileVars('stage'));
      await cmd('httpme.deleteEnvironment', 'qa', true);
      assert.equal(existsSync(join(dir(), 'qa.json')), false);

      const pm = join(root(), 'zz-postman.json');
      writeFileSync(pm, JSON.stringify({ name: 'Staging', values: [{ key: 'baseUrl', value: 'https://s', enabled: true }, { key: 'pw', value: 'p4ss', type: 'secret', enabled: true }] }));
      try {
        await cmd('httpme.importEnvironment', vscode.Uri.file(pm));
      } finally {
        rmSync(pm, { force: true });
      }
      assert.deepEqual(fileVars('Staging').map((x) => x.key), ['baseUrl', 'pw', 'apiKey']);
      assert.equal(await api().envs.secret('Staging', 'pw'), 'p4ss');
      assert.deepEqual(fileVars('dev').map((x) => x.key), ['baseUrl', 'apiKey', 'pw'], 'key baru dari import ikut ke Environment lain (NULL)');
    } finally {
      await cmd('httpme.showCollections');
      await cleanup();
    }
  },

  async 'Editor Environment: custom editor default, tambah / rename / hapus key ke semua Environment, secret, current value, dirty/undo/save'() {
    try {
      await setup();
      await cmd('vscode.open', envUri('dev'));
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputCustom && input.viewType === 'httpme.environment', 'file Environment dibuka di editor tabel');
      const doc = await vscode.workspace.openTextDocument(envUri('dev'));
      await api().envOp(doc, { type: 'addKey', key: 'clientId' }, false);
      assert.equal(doc.isDirty, true);
      assert.deepEqual(fileVars('uat').map((x) => [x.key, x.value]).pop(), ['clientId', null], 'Environment lain langsung dapat key NULL');
      await cmd('undo');
      await until(() => !doc.getText().includes('clientId'), 'undo');
      await cmd('redo');
      await until(() => doc.getText().includes('clientId'), 'redo');
      assert.equal(await doc.save(), true);
      assert.equal(doc.isDirty, false);

      await api().envOp(doc, { type: 'renameKey', from: 'apiKey', to: 'token' }, false);
      assert.ok(fileVars('uat').some((x) => x.key === 'token' && x.value === 'uat-key'));
      assert.ok(doc.getText().includes('"token"'));
      await api().envOp(doc, { type: 'deleteKey', key: 'clientId', scope: 'this' }, false);
      await api().envOp(doc, { type: 'deleteKey', key: 'path', scope: 'all' }, false);
      assert.deepEqual(fileVars('uat').map((x) => x.key), ['baseUrl', 'token', 'clientId']);
      assert.ok(!doc.getText().includes('"path"'));

      await api().envOp(doc, { type: 'setSecret', key: 'token', secret: true }, false);
      assert.deepEqual(fileVars('uat').find((x) => x.key === 'token'), { key: 'token', secret: true }, 'nilai keluar dari file');
      assert.equal(await api().envs.secret('uat', 'token'), 'uat-key', 'nilai pindah ke SecretStorage');
      assert.ok(doc.getText().includes('"secret": true'));

      await api().envOp(doc, { type: 'setCurrent', key: 'baseUrl', value: 'http://localhost:1' }, false);
      assert.deepEqual(api().envs.current('dev'), { baseUrl: 'http://localhost:1' });
      await api().envOp(doc, { type: 'persistAll' }, false);
      assert.ok(doc.getText().includes('http://localhost:1'));
      assert.deepEqual(api().envs.current('dev'), {});
      await doc.save();
    } finally {
      await cleanup();
    }
  },

  async 'key tidak sama dari luar (git pull): pesan + Sync; All Environments berisi matriks'() {
    try {
      await setup();
      writeFileSync(join(dir(), 'uat.json'), JSON.stringify({ httpmeFormat: 1, variables: [{ key: 'baseUrl', value: 'https://u' }] }));
      await wait(500);
      assert.equal(await api().envs.checkKeys(), '2 keys missing in Environment "uat"');
      assert.deepEqual(await api().envs.sync(), ['uat']);
      assert.deepEqual(fileVars('uat').map((x) => [x.key, x.value]), [['baseUrl', 'https://u'], ['apiKey', null], ['path', null]]);
      assert.equal(await api().envs.checkKeys(), '');
      await cmd('httpme.compareEnvironments');
      await until(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.label === 'All Environments'), 'tab All Environments');
      const m = await api().compareView();
      assert.deepEqual(m.keys, ['baseUrl', 'apiKey', 'path']);
      assert.deepEqual(m.columns.map((c) => c.name), ['dev', 'uat']);
      assert.deepEqual(m.columns[0].vars.apiKey, { value: null });
    } finally {
      await cleanup();
    }
  },

  async 'Diagnostics di Problems, Quick Fix, Hover, Definition, References, autocomplete {{'() {
    const file = join(root(), 'zz-vars.http');
    const script = join(root(), 'pre-request.js');
    try {
      await setup();
      writeFileSync(file, 'GET {{baseUrl}}/x?k={{apiKey}}&m={{nope}}&d={{$nope}}\n');
      writeFileSync(script, "httpme.environment.set('apiKey', '1');\n");
      const uri = vscode.Uri.file(file);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await until(() => vscode.languages.getDiagnostics(uri).length === 3, 'diagnostics');
      const diags = vscode.languages.getDiagnostics(uri);
      assert.deepEqual(diags.map((d) => [d.message, d.severity, d.source]), [
        ['apiKey is NULL in Environment "dev"', vscode.DiagnosticSeverity.Error, 'http.me'],
        ['Variable "nope" not found', vscode.DiagnosticSeverity.Error, 'http.me'],
        ['Unknown dynamic variable "$nope"', vscode.DiagnosticSeverity.Error, 'http.me'],
      ]);
      assert.deepEqual([diags[0].range.start.character, diags[0].range.end.character], [20, 30]);
      // file Environment: "value": null
      const envDoc = await vscode.workspace.openTextDocument(envUri('dev'));
      await until(() => vscode.languages.getDiagnostics(envDoc.uri).some((d) => d.message === 'apiKey has no value (NULL) in Environment "dev"'), 'diagnostics JSON');

      const fixes = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, diags[1].range);
      const ours = (list: vscode.CodeAction[]) => list.filter((f) => f.command?.command.startsWith('httpme.')).map((f) => f.title); // aksi bawaan VS Code (chat) diabaikan
      assert.deepEqual(ours(fixes), ['Set value of nope in Environment "dev"…', 'Set nope in Globals…', 'Add variable "nope" to every Environment', 'Open All Environments']);
      const nullFix = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, diags[0].range);
      assert.deepEqual(ours(nullFix), ['Set value of apiKey in Environment "dev"…', 'Set apiKey in Globals…', 'Open All Environments']);

      const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, new vscode.Position(0, 8));
      const md = (hover[0].contents[0] as vscode.MarkdownString).value;
      assert.match(md, /\*\*dev\*\* \(active\): `https:\/\/dev\.example\.com\/api`/);
      assert.match(md, /uat: `https:\/\/uat\.example\.com\/api`/);

      const defs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', uri, new vscode.Position(0, 8));
      assert.equal(defs[0].uri.fsPath, envUri('dev').fsPath);
      assert.equal(envDoc.getText(defs[0].range), 'baseUrl', 'Peek / F12 ke baris key di JSON');

      const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, new vscode.Position(0, 24));
      assert.deepEqual(refs.map((r) => r.uri.path.split('/').pop()).sort(), ['pre-request.js', 'zz-vars.http']);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(1, 0), 'X: {{ba');
      await vscode.workspace.applyEdit(edit);
      const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, new vscode.Position(1, 7), '{');
      const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
      assert.ok(labels.includes('baseUrl') && labels.includes('$guid'), labels.join(','));
      assert.equal(list.items.find((i) => i.label === 'baseUrl')!.insertText, 'baseUrl}}');
      const undoEdit = new vscode.WorkspaceEdit();
      undoEdit.delete(uri, new vscode.Range(1, 0, 1, 7));
      await vscode.workspace.applyEdit(undoEdit);
      await doc.save();

      // Quick Fix Set value → diagnostics hilang; ganti Environment → diagnostics ikut
      await cmd('httpme.setVariableValue', 'apiKey', 'dev', 'dev-key');
      await until(() => !vscode.languages.getDiagnostics(uri).some((d) => d.message.startsWith('apiKey')), 'apiKey terisi');
      await cmd('httpme.addVariableToAll', 'nope');
      await api().envs.setActive('uat');
      await until(() => vscode.languages.getDiagnostics(uri).some((d) => d.message === 'nope is NULL in Environment "uat" (also NULL in: dev)'), 'ganti Environment');

      // Ctrl+Click / gotoVariable: editor Environment aktif + sorot key
      await cmd('httpme.gotoVariable', 'nope');
      await until(() => api().focusOf(envUri('uat'))?.key === 'nope', 'focus');
      assert.deepEqual(api().focusOf(envUri('uat')), { key: 'nope', mode: 'fill' });
      await cmd('httpme.gotoVariable', 'brandNew');
      await until(() => api().focusOf(envUri('uat'))?.key === 'brandNew', 'focus add');
      assert.equal(api().focusOf(envUri('uat'))!.mode, 'add');
    } finally {
      await cleanup();
      rmSync(file, { force: true });
      rmSync(script, { force: true });
    }
  },

  async 'Send: {{var}} diganti dari Environment aktif; NULL → Cancel / Send anyway / Fill in now; Globals menutup NULL; variable dinamis'() {
    const seen: string[] = [];
    const srv = await startServer(async (req) => { seen.push(req.url ?? ''); return { body: 'ok' }; });
    const file = join(root(), 'zz-send.http');
    try {
      await setup();
      writeFileSync(file, `GET ${srv.url}/{{path}}?k={{apiKey}}&r={{$randomInt 5 6}}\n`);
      const uri = vscode.Uri.file(file);
      await cmd('vscode.openWith', uri, 'httpme.request');
      api().setNullPrompt(async () => undefined);
      await cmd('httpme.sendRequest');
      await wait(300);
      assert.deepEqual(seen, [], 'Cancel: tidak dikirim');
      let asked: string[] = [];
      api().setNullPrompt(async (n) => { asked = n; return 'send'; });
      await cmd('httpme.sendRequest');
      await until(() => api().viewOf(uri.toString())?.kind === 'response', 'response');
      assert.deepEqual(asked, ['apiKey']);
      assert.equal(seen.pop(), '/echo?k={{apiKey}}&r=5');
      api().setNullPrompt(async () => 'fill');
      await cmd('httpme.sendRequest');
      await until(() => api().focusOf(envUri('dev'))?.key === 'apiKey', 'Fill in now');
      assert.equal(api().focusOf(envUri('dev'))!.mode, 'fill');
      // Globals mengisi NULL di Environment aktif
      await cmd('httpme.setVariableValue', 'apiKey', '', 'from-globals');
      api().setNullPrompt(async () => { throw new Error('tidak boleh bertanya'); });
      await cmd('vscode.openWith', uri, 'httpme.request');
      await cmd('httpme.sendRequest');
      await until(() => seen.length === 1, 'kirim dengan Globals');
      assert.equal(seen.pop(), '/echo?k=from-globals&r=5');
      // current value menimpa initial value
      await api().envs.write('dev', [...(await api().envs.vars('dev')).map((x) => (x.key === 'apiKey' ? { ...x, value: 'init' } : x))]);
      const doc = await vscode.workspace.openTextDocument(envUri('dev'));
      await api().envOp(doc, { type: 'setCurrent', key: 'apiKey', value: 'cur' }, false);
      await cmd('vscode.openWith', uri, 'httpme.request');
      await cmd('httpme.sendRequest');
      await until(() => seen.length === 1, 'kirim dengan current value');
      assert.equal(seen.pop(), '/echo?k=cur&r=5');
    } finally {
      await srv.close();
      await cleanup();
      rmSync(file, { force: true });
    }
  },

  async 'paste cURL & Replace Values with Variables: nilai Environment jadi {{VARIABLE}}'() {
    const file = join(root(), 'zz-varize.http');
    try {
      await setup();
      writeFileSync(file, 'GET https://dev.example.com/api/users?page=2\nX-Path: echo\n');
      await vscode.commands.executeCommand('httpme.replaceValuesWithVariables', vscode.Uri.file(file));
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      assert.equal(doc.getText(), 'GET {{baseUrl}}/users?page=2\nX-Path: {{path}}\n');
      await doc.save();
      const { importCurlText } = await import('../../src/httpEditor');
      const created = await importCurlText(`curl 'https://uat.example.com/api/x' -H 'X-Key: uat-key'`);
      const text = (await vscode.workspace.openTextDocument(created)).getText();
      assert.match(text, /^GET \{\{baseUrl\}\}\/x\nX-Key: \{\{apiKey\}\}\n$/, 'nilai Environment lain (uat) juga dikenali');
    } finally {
      for (const d of vscode.workspace.textDocuments.filter((x) => x.isDirty && x.uri.scheme === 'untitled')) {
        await vscode.window.showTextDocument(d);
        await cmd('workbench.action.revertAndCloseActiveEditor');
      }
      await cleanup();
      rmSync(file, { force: true });
    }
  },

  async 'Command Palette: semua command httpme terdaftar di contributes.commands (kategori http.me), tanpa dropdown Environment di panel'() {
    const pkg = vscode.extensions.getExtension('exeltarkus.httpme')!.packageJSON as { contributes: { commands: { command: string; title: string; category: string }[]; keybindings: { command: string; key: string; mac: string }[] } };
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    const registered = (await vscode.commands.getCommands(true)).filter((c) => c.startsWith('httpme.') && !c.startsWith('httpme.sidebar.') && !c.endsWith('.focus') && !c.includes('resetViewLocation'));
    assert.deepEqual(registered.filter((c) => !declared.has(c)), [], 'command terdaftar tapi tidak ada di package.json');
    assert.deepEqual([...declared].filter((c) => !registered.includes(c)), [], 'command di package.json tanpa implementasi');
    assert.deepEqual(pkg.contributes.commands.filter((c) => c.category !== 'http.me').map((c) => c.command), []);
    for (const id of ['httpme.selectEnvironment', 'httpme.nextEnvironment', 'httpme.previousEnvironment', 'httpme.editActiveEnvironment', 'httpme.manageEnvironments', 'httpme.newEnvironment']) assert.ok(declared.has(id), id);
    const html = readFileSync(join(vscode.extensions.getExtension('exeltarkus.httpme')!.extensionPath, 'media', 'webview', 'panel.html'), 'utf8');
    assert.doesNotMatch(html, /<select[^>]*environment/i, 'tanpa dropdown Environment di panel');
  },

  async 'Keybinding: Ctrl+Alt+E / Ctrl+Alt+] / Ctrl+Alt+[ / Ctrl+Alt+Shift+E (mac Cmd), tidak bentrok dengan keybinding bawaan VS Code'() {
    const pkg = vscode.extensions.getExtension('exeltarkus.httpme')!.packageJSON as { contributes: { keybindings: { command: string; key: string; mac: string }[] } };
    const kb = Object.fromEntries(pkg.contributes.keybindings.map((k) => [k.command, `${k.key}|${k.mac}`]));
    assert.equal(kb['httpme.selectEnvironment'], 'ctrl+alt+e|cmd+alt+e');
    assert.equal(kb['httpme.nextEnvironment'], 'ctrl+alt+]|cmd+alt+]');
    assert.equal(kb['httpme.previousEnvironment'], 'ctrl+alt+[|cmd+alt+[');
    assert.equal(kb['httpme.editActiveEnvironment'], 'ctrl+alt+shift+e|cmd+alt+shift+e');
    // daftar keybinding bawaan VS Code (dokumen virtual Default Keyboard Shortcuts)
    const defaults = (await vscode.workspace.openTextDocument(vscode.Uri.parse('vscode://defaultsettings/keybindings.json'))).getText();
    assert.ok(defaults.length > 1000, 'keybinding bawaan terbaca');
    const lines = defaults.split('\n');
    for (const key of ['ctrl+alt+e', 'ctrl+alt+]', 'ctrl+alt+[', 'ctrl+alt+shift+e', 'cmd+alt+e', 'cmd+alt+]', 'cmd+alt+[', 'cmd+alt+shift+e']) {
      const i = lines.findIndex((l) => l.includes(`"key": "${key}"`) && !l.includes('"httpme.')); // baris milik http.me sendiri ikut tercantum
      assert.ok(i < 0, `${key} sudah dipakai VS Code: ${lines.slice(i, i + 3).join(' ').replace(/\s+/g, ' ')}`);
    }
    await vscode.commands.executeCommand('httpme.nextEnvironment');
  },
};
