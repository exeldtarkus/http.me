import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers/server';
import type { ITests } from './it/index';

type View = { kind: string; status?: string; message?: string; scripts?: { tests: { name: string; passed: boolean }[]; console: { text: string }[]; error?: string } };
type Api = {
  viewOf(uri: string): View | undefined;
  envs: { write(name: string, vars: { key: string; value: string | null; secret?: boolean }[]): Promise<void>; setActive(n: string | undefined): Promise<void>; current(n: string): Record<string, string> };
};
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

async function until<T>(what: string, fn: () => T | undefined, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = fn(); if (v) return v; }
  throw new Error(`timeout: ${what}`);
}
/** tulis file .http + script di folder sementara, Send, tunggu hasil */
async function sendFile(dir: string, files: Record<string, string>): Promise<View> {
  for (const [n, t] of Object.entries(files)) { mkdirSync(join(dir, n, '..'), { recursive: true }); writeFileSync(join(dir, n), t); }
  const uri = vscode.Uri.file(join(dir, 'r.http'));
  const doc = await vscode.workspace.openTextDocument(uri);
  // dokumen yang sudah terbuka menunggu VS Code membaca ulang file dari disk
  await until('dokumen .http terbaru', () => doc.getText() === readFileSync(uri.fsPath, 'utf8'));
  await vscode.commands.executeCommand('httpme.sendBlock', doc.uri, 0);
  return until('hasil Send', () => { const v = api().viewOf(uri.toString()); return v && !['queued', 'running'].includes(v.kind) ? v : undefined; });
}

export const tests: ITests = {
  async 'Send: pre ubah request + httpme.vars ke {{var}}, post test + environment.set (current value, file tetap); pre gagal / skip = tidak dikirim'() {
    await vscode.commands.executeCommand('httpme.whatsNew');
    const seen: { path: string; sig?: string; trace?: string }[] = [];
    const srv = await startServer(async (req) => {
      seen.push({ path: req.url!, sig: req.headers['x-sig'] as string, trace: req.headers['x-trace'] as string });
      return { headers: { 'content-type': 'application/json' }, body: '{"token":"tk-1"}' };
    });
    const dir = join(root(), 'tmp-flow-it');
    const envFile = join(root(), '.httpme', 'environments', 'dev.json');
    try {
      await api().envs.write('dev', [{ key: 'token', value: 'initial' }]);
      await api().envs.setActive('dev');
      const before = readFileSync(envFile, 'utf8');
      const v = await sendFile(dir, {
        'pre-request.js': 'httpme.request.headers.set("X-Trace", "t-" + httpme.environment.get("token"));',
        'sign.js': 'httpme.vars.set("sig", "s1"); console.log("signed");',
        'r.http': `< ./sign.js\nGET ${srv.url}/a\nX-Sig: {{sig}}\n\n> {% httpme.test("status", () => httpme.expect(httpme.response.status).toBe(200)); httpme.environment.set("token", httpme.response.json().token); %}\n`,
      });
      assert.equal(v.kind, 'response', JSON.stringify(v));
      assert.deepEqual(seen, [{ path: '/a', sig: 's1', trace: 't-initial' }]);
      assert.deepEqual(v.scripts?.tests, [{ name: 'status', passed: true }]);
      assert.deepEqual(v.scripts?.console.map((x) => x.text), ['signed']);
      assert.equal(api().envs.current('dev').token, 'tk-1', 'current value diisi script');
      assert.equal(readFileSync(envFile, 'utf8'), before, 'file Environment di repo tidak berubah');

      const bad = await sendFile(dir, { 'sign.js': 'throw new Error("no key")' });
      assert.equal(bad.kind, 'error');
      assert.match(bad.message!, /Pre-request script failed: \.\/sign\.js: Error: no key/);
      assert.equal(seen.length, 1, 'pre gagal = tidak dikirim');

      const skip = await sendFile(dir, { 'sign.js': 'httpme.skip()' });
      assert.equal(skip.message, 'Request skipped by a pre-request script.');
      assert.equal(seen.length, 1);

      const missing = await sendFile(dir, { 'r.http': `< ./nope.js\nGET ${srv.url}/a\n` });
      assert.match(missing.message!, /Script file not found: \.\/nope\.js/);
      assert.equal(seen.length, 1);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api().envs.setActive(undefined);
      rmSync(dir, { recursive: true, force: true });
      rmSync(envFile, { force: true });
      await srv.close();
    }
  },
};
