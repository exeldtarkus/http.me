import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ITests } from './it/index';

type Node = { kind: string; uri?: vscode.Uri; rel?: string; what?: string; tab?: { uri: string; dirty: boolean; pinned: boolean } };
type Api = { sidebar: { mode: string; getChildren(n?: Node): Promise<Node[]>; getTreeItem(n: Node): Promise<vscode.TreeItem>;
  handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void>; handleDrag(nodes: Node[], data: vscode.DataTransfer): void } };
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const name = (n: Node) => n.uri?.path.split('/').pop() ?? n.rel ?? n.what ?? n.kind;
const COL = 'zz-itest-col';

async function children(n?: Node): Promise<Node[]> {
  return api().sidebar.getChildren(n);
}
async function find(nodeName: string, n?: Node): Promise<Node> {
  const hit = (await children(n)).find((x) => name(x) === nodeName);
  assert.ok(hit, `${nodeName} tidak ada di tree`);
  return hit;
}

export const tests: ITests = {
  async 'mode sidebar: Show Collections / Environments / Open mengganti isi view'() {
    await vscode.commands.executeCommand('httpme.showEnvironments');
    assert.equal(api().sidebar.mode, 'environments');
    assert.deepEqual((await children()).map((n) => n.kind), ['eglobals', 'enone', 'eempty', 'eempty']);
    await vscode.commands.executeCommand('httpme.showOpen');
    assert.equal(api().sidebar.mode, 'open');
    await vscode.commands.executeCommand('httpme.showCollections');
    assert.equal(api().sidebar.mode, 'collections');
  },
  async 'Collections: file .http workspace + label method host; tampilan rata; filter'() {
    const get = await find('get.http');
    const item = await api().sidebar.getTreeItem(get);
    assert.equal(item.label, 'get');
    assert.equal(item.description, 'GET httpbin.org');
    assert.equal(item.command?.arguments?.[1], true, 'klik request membuka editor tanpa mengambil fokus (tombol Delete tetap jalan di sidebar)');
    await vscode.commands.executeCommand('httpme.filterCollections', 'post.http');
    assert.deepEqual((await children()).map(name), ['post.http']);
    await vscode.commands.executeCommand('httpme.clearFilter');
    await vscode.commands.executeCommand('httpme.toggleFlat');
    assert.ok((await children()).every((n) => n.kind === 'file'));
    await vscode.commands.executeCommand('httpme.toggleFlat');
  },
  async 'New Collection + folder kosong + Add request -> Save -> rename / duplicate / move / Copy as cURL / delete'() {
    const col = join(root(), COL);
    try {
      await vscode.commands.executeCommand('httpme.newCollection', undefined, COL);
      assert.ok(existsSync(join(col, '.httpmekeep')));
      await wait(300);
      const colNode = await find(COL);
      const empty = await children(colNode);
      assert.deepEqual(empty.map((n) => n.what), ['label', 'addRequest', 'addFolder']);
      assert.equal((await api().sidebar.getTreeItem(empty[0])).label, 'Collection is empty');
      await vscode.commands.executeCommand('httpme.newFolder', colNode, 'sub');
      assert.ok(existsSync(join(col, 'sub', '.httpmekeep')));

      // Add request dari folder: tab untitled terikat folder, Save menulis <folder>/<nama>.http
      await vscode.commands.executeCommand('httpme.newRequestIn', colNode);
      const untitled = (vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputCustom).uri;
      assert.equal(untitled.scheme, 'untitled');
      await vscode.commands.executeCommand('httpme.saveUntitled', untitled, { name: 'ping', folder: vscode.Uri.file(col) });
      assert.equal(readFileSync(join(col, 'ping.http'), 'utf8'), 'GET https://\n');
      assert.equal(existsSync(join(col, '.httpmekeep')), false, '.httpmekeep dihapus begitu folder berisi .http');
      const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputCustom;
      assert.equal(active.uri.fsPath, join(col, 'ping.http'), 'file baru dibuka di panel');

      await vscode.commands.executeCommand('httpme.rename', vscode.Uri.file(join(col, 'ping.http')), 'pong');
      assert.ok(existsSync(join(col, 'pong.http')));
      await vscode.commands.executeCommand('httpme.duplicate', vscode.Uri.file(join(col, 'pong.http')));
      assert.ok(existsSync(join(col, 'pong copy.http')));
      await vscode.commands.executeCommand('httpme.moveTo', vscode.Uri.file(join(col, 'pong copy.http')), vscode.Uri.file(join(col, 'sub')));
      assert.ok(existsSync(join(col, 'sub', 'pong copy.http')));
      assert.equal(existsSync(join(col, 'sub', '.httpmekeep')), false);

      await vscode.commands.executeCommand('httpme.copyAsCurl', vscode.Uri.file(join(root(), 'get.http')));
      assert.match(await vscode.env.clipboard.readText(), /^curl 'https:\/\/httpbin\.org\/get\?hello=world'/);

      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('httpme.delete', vscode.Uri.file(col), true);
      assert.equal(existsSync(col), false);
    } finally {
      rmSync(col, { recursive: true, force: true });
    }
  },
  async 'Open: tab terbuka + untitled, ● belum disimpan, Pin di atas'() {
    await vscode.commands.executeCommand('httpme.showOpen');
    await vscode.window.showTextDocument(vscode.Uri.file(join(root(), 'get.http')), { preview: false });
    await vscode.commands.executeCommand('httpme.newRequest');
    await wait(200);
    const top = await children();
    const untitledGroup = top.find((n) => n.kind === 'ountitled');
    assert.ok(untitledGroup, 'grup Untitled');
    const untitled = await children(untitledGroup);
    assert.ok(untitled.some((n) => n.tab!.dirty), 'request baru belum disimpan = ●');
    const getTab = top.find((n) => n.kind === 'otab' && n.tab!.uri.endsWith('/get.http'))!;
    assert.equal(getTab.tab!.dirty, false);
    await vscode.commands.executeCommand('httpme.pinTab', getTab);
    assert.equal((await children()).filter((n) => n.kind === 'otab')[0].tab!.pinned, true);
    await vscode.commands.executeCommand('httpme.unpinTab', getTab);
    await vscode.commands.executeCommand('httpme.showCollections');
  },
  async 'Import from Clipboard = tab Untitled baru; paste di tab tersimpan tidak mengubah file'() {
    await vscode.env.clipboard.writeText(`curl 'https://api.test/x' -H 'sec-fetch-mode: cors' --data-raw '{"a":1}'`);
    await vscode.commands.executeCommand('httpme.importFromClipboard');
    const uri = (vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputCustom).uri;
    assert.equal(uri.scheme, 'untitled');
    const text = (await vscode.workspace.openTextDocument(uri)).getText();
    assert.match(text, /^# @disabled sec-fetch-mode: cors\nPOST https:\/\/api\.test\/x\nContent-Type: application\/x-www-form-urlencoded\n\n\{"a":1\}\n$/);
  },
  async 'klik di Collections: 1 request dan multi-request -> panel http.me'() {
    const multi = join(root(), 'zz-itest-multi.http');
    writeFileSync(multi, '### A\nGET https://a/1\n\n### B\nGET https://a/2\n');
    try {
      await vscode.commands.executeCommand('httpme.openRequest', vscode.Uri.file(multi));
      const m = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(m instanceof vscode.TabInputCustom && m.viewType === 'httpme.request', 'multi-request = panel (tab per request)');
      await vscode.commands.executeCommand('httpme.openRequest', vscode.Uri.file(join(root(), 'get.http')));
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputCustom && input.viewType === 'httpme.request', '1 request = panel');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      rmSync(multi, { force: true });
    }
  },
  async 'drag & drop: file ke folder lewat handleDrop (MIME tree)'() {
    const dir = join(root(), 'zz-itest-dnd');
    mkdirSync(join(dir, 'target'), { recursive: true });
    writeFileSync(join(dir, 'a.http'), 'GET https://a\n');
    try {
      await vscode.commands.executeCommand('httpme.refreshCollections');
      await wait(300);
      const folder = await find('zz-itest-dnd');
      const file = (await children(folder)).find((n) => name(n) === 'a.http')!;
      const data = new vscode.DataTransfer();
      api().sidebar.handleDrag([file], data);
      await api().sidebar.handleDrop({ kind: 'folder', root: vscode.workspace.workspaceFolders![0], rel: 'zz-itest-dnd/target' } as unknown as Node, data);
      assert.ok(existsSync(join(dir, 'target', 'a.http')));
      assert.equal(existsSync(join(dir, 'a.http')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  async 'paste cURL di tab tersimpan: tab Untitled baru, file asli tidak berubah'() {
    const uri = vscode.Uri.file(join(root(), 'get.http'));
    const before = readFileSync(uri.fsPath, 'utf8');
    const { importCurlText } = await import('../../src/httpEditor');
    const created = await importCurlText(`curl https://api.test/pasted`, await vscode.workspace.openTextDocument(uri));
    assert.equal(created.scheme, 'untitled');
    assert.match((await vscode.workspace.openTextDocument(created)).getText(), /GET https:\/\/api\.test\/pasted/);
    assert.equal(readFileSync(uri.fsPath, 'utf8'), before);
  },
};
