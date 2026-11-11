import * as assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ITests } from './it/index';

type Reply = { type: string; text: string; secrets: boolean };
type Api = {
  snippetCall(uri: vscode.Uri, opts: unknown, request?: unknown): Promise<Reply[]>;
  envs: { write(name: string, vars: { key: string; value: string | null; secret?: boolean }[]): Promise<void>; setSecret(env: string, key: string, value: string | undefined): Promise<void>; setActive(name: string | undefined): Promise<void> };
};
const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const base = { language: 'curl', longForm: false, resolve: true, followRedirects: true, cookies: false, disabledHeaders: false, multiLine: true, compactBody: true };

export const tests: ITests = {
  async 'Code snippet: bahasa & opsi, {{variable}} ikut Environment aktif, secret ******** (host panel)'() {
    await vscode.commands.executeCommand('httpme.whatsNew'); // aktifkan extension
    const api = vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
    const dir = join(root(), 'zz-itest-snippet');
    const file = join(dir, 'request.http');
    const uri = vscode.Uri.file(file);
    const envDir = join(root(), '.httpme', 'environments');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, 'POST {{BASE}}/items?x=1\nContent-Type: application/json\n# @auth bearer token="{{TOKEN}}"\n\n{\n  "name": "a  b",\n  "n": [1, 2]\n}\n');
    const snippet = async (o: Record<string, unknown> = {}) => (await api.snippetCall(uri, { ...base, ...o }))[0];
    try {
      await api.envs.write('zz-snip-dev', [{ key: 'BASE', value: 'https://dev.example.com' }, { key: 'TOKEN', value: null, secret: true }]);
      await api.envs.write('zz-snip-uat', [{ key: 'BASE', value: 'https://uat.example.com' }, { key: 'TOKEN', value: null, secret: true }]);
      await api.envs.setSecret('zz-snip-dev', 'TOKEN', 'tok-dev-SECRET');
      await api.envs.setSecret('zz-snip-uat', 'TOKEN', 'tok-uat-SECRET');
      await api.envs.setActive('zz-snip-dev');

      // variable & secret mengikuti Environment aktif; secret tidak pernah muncul di teks panel
      let r = await snippet();
      assert.equal(r.type, 'snippet');
      assert.match(r.text, /curl -X POST 'https:\/\/dev\.example\.com\/items\?x=1'/);
      assert.match(r.text, /-H 'Authorization: Bearer \*{8}'/);
      assert.ok(!r.text.includes('SECRET'), 'secret tidak bocor');
      assert.equal(r.secrets, true);
      assert.match(r.text, /--data-raw '\{"name":"a  b","n":\[1,2\]\}'/, 'JSON dipadatkan (aman dipaste ke cmd / PowerShell)');

      // Environment berubah -> snippet berikutnya memakai Environment baru
      await api.envs.setActive('zz-snip-uat');
      r = await snippet();
      assert.match(r.text, /https:\/\/uat\.example\.com\/items/);
      assert.ok(!r.text.includes('dev.example.com'));

      // resolve off: {{variable}} apa adanya, tidak ada secret
      r = await snippet({ resolve: false });
      assert.match(r.text, /'\{\{BASE\}\}\/items\?x=1'/);
      assert.equal(r.secrets, false);

      // bahasa & opsi
      assert.match((await snippet({ language: 'powershell' })).text, /^Invoke-WebRequest -UseBasicParsing -Uri "https:\/\/uat\.example\.com\/items\?x=1" `\n-Method "POST"/);
      assert.match((await snippet({ language: 'cmd' })).text, /^curl -X POST \^"https:\/\/uat\.example\.com\/items\?x=1\^" \^\n  -H /);
      assert.match((await snippet({ longForm: true, multiLine: false })).text, /^curl --request POST 'https:[^\n]* --header 'Content-Type: application\/json'[^\n]*--location$/);
      assert.match((await snippet({ compactBody: false })).text, /--data-raw '\{\n/);
      assert.doesNotMatch((await snippet({ followRedirects: false })).text, /-L/);
      await assert.rejects(api.snippetCall(uri, { ...base, language: 'bash' }), /Invalid snippet options/);
    } finally {
      await api.envs.setActive(undefined);
      for (const n of ['zz-snip-dev', 'zz-snip-uat']) { await api.envs.setSecret(n, 'TOKEN', undefined); rmSync(join(envDir, `${n}.json`), { force: true }); }
      rmSync(dir, { recursive: true, force: true });
    }
  },

  async 'Code snippet: Environment aktif rusak -> panel memberi pesan, tidak kosong'() {
    await vscode.commands.executeCommand('httpme.whatsNew');
    const api = vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
    const dir = join(root(), 'zz-itest-snippet-bad');
    const file = join(dir, 'request.http');
    const envDir = join(root(), '.httpme', 'environments');
    mkdirSync(dir, { recursive: true });
    mkdirSync(envDir, { recursive: true });
    writeFileSync(file, 'GET {{BASE}}/items\n');
    const bad = join(envDir, 'zz-snip-bad.json');
    writeFileSync(bad, '{ "variables": [ }'); // JSON rusak: hooks.resolve gagal
    try {
      await api.envs.setActive('zz-snip-bad');
      const out = await api.snippetCall(vscode.Uri.file(file), base) as Reply[];
      assert.equal(out.length, 1, 'panel tetap menerima balasan');
      assert.equal(out[0].type, 'snippet');
      assert.match(out[0].text, /Could not generate the code snippet/);
    } finally {
      await api.envs.setActive(undefined);
      rmSync(bad, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
