import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers/server';
import type { ITests } from './it/index';

type Entry = { id: string; time: number; method: string; url: string; status?: number; cancelled?: boolean; error?: string; file?: string; text: string };
type Api = {
  viewOf(uri: string): { kind: string; status?: string } | undefined;
  statusBar(): { running?: { text: string; tooltip: string }; history: string } | undefined;
  history: { list(): Promise<Entry[]>; action(id: string, a: 'open' | 'send' | 'curl' | 'remove'): Promise<void> };
};
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function until<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = await fn(); if (v) return v; }
  throw new Error(`timeout: ${what}`);
}

export const tests: ITests = {
  async 'status bar ⟳ running: tampil hanya saat ada request, tooltip per request; hilang setelah Cancel All'() {
    await vscode.commands.executeCommand('httpme.whatsNew');
    const srv = await startServer(async () => { await wait(3000); return { body: 'late' }; });
    const dir = join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'tmp-hist-it');
    try {
      assert.equal(api().statusBar()?.running, undefined, 'idle: tidak tampil');
      assert.equal(api().statusBar()?.history, '$(history) History');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'slow.http'), `POST ${srv.url}/pos/log\n`);
      const doc = await vscode.workspace.openTextDocument(join(dir, 'slow.http'));
      void vscode.commands.executeCommand('httpme.sendBlock', doc.uri, 0);
      const run = await until('status running', () => api().statusBar()?.running);
      assert.match(run.text, /^\$\(sync~spin\) 1 request running · \ds$/);
      assert.match(run.tooltip, /^POST \/pos\/log · \ds\nClick to cancel$/);
      await vscode.commands.executeCommand('httpme.cancelAllRequests');
      await until('status hilang', () => !api().statusBar()?.running);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await srv.close();
    }
  },
  async 'History: Send dicatat (tanpa Authorization), buka entri (request + response), Send again, Copy as cURL, Remove'() {
    const srv = await startServer(async (req) => ({ status: req.url === '/missing' ? 404 : 200, headers: { 'x-hist': '1', 'set-cookie': 'sid=secret' }, body: 'ok' }));
    const dir = join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'tmp-hist-it');
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'h.http');
      writeFileSync(file, `GET ${srv.url}/missing\nAuthorization: Bearer secret-token\nX-A: 1\n`);
      const doc = await vscode.workspace.openTextDocument(file);
      const start = Date.now(); // History bertahan antar run itest: entri lama diabaikan
      const mine = async () => (await api().history.list()).filter((x) => x.file === doc.uri.toString() && x.time >= start);
      await vscode.commands.executeCommand('httpme.sendBlock', doc.uri, 0);
      const e = await until('entri History', async () => (await mine())[0]);
      assert.equal(e.status, 404);
      assert.equal((e as { response?: { body?: string } }).response?.body, 'ok', 'body response disimpan untuk contoh export OpenAPI');
      const hs = (e as { response?: { headers?: [string, string][] } }).response?.headers ?? [];
      assert.ok(hs.some(([k, v]) => k === 'x-hist' && v === '1'), 'header response disimpan');
      assert.ok(!hs.some(([k]) => k === 'set-cookie'), 'Set-Cookie tidak disimpan');
      assert.equal(e.text, `GET ${srv.url}/missing\nX-A: 1\n`, 'header Authorization tidak disimpan');

      await api().history.action(e.id, 'curl');
      assert.match(await vscode.env.clipboard.readText(), /^curl /);
      await api().history.action(e.id, 'open');
      const opened = await until('tab entri History', () => {
        const u = (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri })?.uri;
        return u?.scheme === 'untitled' ? u : undefined;
      });
      assert.equal(api().viewOf(opened.toString())?.status, '404', 'response entri History tampil di tab-nya');

      await api().history.action(e.id, 'send');
      await until('Send again tercatat', async () => (await mine()).length === 2);

      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      rmSync(file);
      await api().history.action(e.id, 'open');
      const tab = await until('untitled', () => (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri })?.uri);
      assert.equal(tab.scheme, 'untitled', 'file asal sudah dihapus: tab untitled');
      assert.match((await vscode.workspace.openTextDocument(tab)).getText(), /^# From History: executed \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \((?:.+ ago|just now)\)\n/);
      assert.ok((await vscode.workspace.openTextDocument(tab)).getText().endsWith(e.text));

      await api().history.action(e.id, 'remove');
      assert.ok(!(await api().history.list()).some((x) => x.id === e.id));
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      rmSync(dir, { recursive: true, force: true });
      await srv.close();
    }
  },
  async 'History: klik entri membuka satu tab history.http (belum disimpan); entri lain ditampilkan di tab yang sama, bukan tab baru'() {
    const srv = await startServer(async (req) => ({ status: req.url === '/b' ? 404 : 200, body: 'ok' }));
    const dir = join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'tmp-hist-one');
    try {
      mkdirSync(dir, { recursive: true });
      const start = Date.now();
      for (const n of ['a', 'b']) {
        writeFileSync(join(dir, `${n}.http`), `GET ${srv.url}/${n}\n`);
        await vscode.commands.executeCommand('httpme.sendBlock', (await vscode.workspace.openTextDocument(join(dir, `${n}.http`))).uri, 0);
      }
      const entry = async (n: string) => until(`entri ${n}`, async () => (await api().history.list()).find((x) => x.time >= start && x.url.endsWith(`/${n}`)));
      const ea = await entry('a');
      const eb = await entry('b');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const historyTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === 'history.http');
      await api().history.action(ea.id, 'open');
      await until('tab history.http', () => historyTabs().length === 1);
      const uri = (historyTabs()[0].input as { uri: vscode.Uri }).uri;
      assert.equal(uri.scheme, 'untitled');
      assert.equal(api().viewOf(uri.toString())?.status, '200');
      await api().history.action(eb.id, 'open');
      await wait(300);
      assert.equal(historyTabs().length, 1, 'tetap satu tab history.http');
      assert.equal(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => /^New Request/.test(t.label)).length, 0, 'tidak ada tab New Request baru');
      assert.match((await vscode.workspace.openTextDocument(uri)).getText(), new RegExp(`GET ${srv.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/b\n`));
      assert.equal(api().viewOf(uri.toString())?.status, '404', 'response entri kedua tampil di tab yang sama');
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      rmSync(dir, { recursive: true, force: true });
      await srv.close();
    }
  },
};
