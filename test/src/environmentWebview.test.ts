import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { join } from 'node:path';

type V = { key: string; value: string | null; secret?: boolean };
const media = join(__dirname, '..', '..', '..', 'media', 'webview');
const env = require(join(media, 'environment.js')) as {
  rowErrors(v: V[]): Record<number, string>; visibleRows(v: V[], cur: Record<string, string>, q: string, nullOnly: boolean): number[]; moveRow(v: V[], from: number, to: number): V[];
};
const compare = require(join(media, 'compare.js')) as { matrix(keys: string[], cols: { name: string; vars: Record<string, unknown> }[]): { key: string; cells: { kind: string }[]; hasNull: boolean }[] };

const vars: V[] = [{ key: 'baseUrl', value: 'https://a' }, { key: 'apiKey', value: null }, { key: 'token', value: null, secret: true }, { key: 'user', value: 'bob' }];

test('editor Environment: nama kosong / duplikat ditandai', () => {
  assert.deepEqual(env.rowErrors([...vars, { key: 'user', value: '' }, { key: ' ', value: '' }]), { 3: 'Duplicate variable "user"', 4: 'Duplicate variable "user"', 5: 'Variable name is required' });
});

test('editor Environment: cari (nama, initial, current; secret hanya nama) + NULL only', () => {
  assert.deepEqual(env.visibleRows(vars, {}, '', false), [0, 1, 2, 3]);
  assert.deepEqual(env.visibleRows(vars, {}, '', true), [1], 'secret NULL dihitung di badge, bukan di filter file');
  assert.deepEqual(env.visibleRows(vars, { user: 'alice' }, 'ALICE', false), [3]);
  assert.deepEqual(env.visibleRows(vars, {}, 'tok', false), [2]);
});

test('editor Environment: drag memindah baris sebelum target', () => {
  assert.deepEqual(env.moveRow(vars, 3, 0).map((x) => x.key), ['user', 'baseUrl', 'apiKey', 'token']);
  assert.deepEqual(env.moveRow(vars, 0, 4).map((x) => x.key), ['apiKey', 'token', 'user', 'baseUrl']);
});

test('All Environments: sel NULL / secret / key hilang, baris bertanda NULL', () => {
  const m = compare.matrix(['a', 'b', 's'], [
    { name: 'dev', vars: { a: { value: '1' }, b: { value: null }, s: { secret: true, set: true } } },
    { name: 'prod', vars: { a: { value: '2' }, s: { secret: true, set: false } } },
  ]);
  assert.deepEqual(m.map((r) => [r.key, r.cells.map((c) => c.kind).join(','), r.hasNull]), [['a', 'value,value', false], ['b', 'null,absent', true], ['s', 'secret,null', true]]);
});

test('review R13: Add variable — Enter tambah & tetap di Add, Tab tambah & pindah ke Initial value, duplikat / kosong ditolak', () => {
  const e = env as unknown as { addKeyAction(key: string, existing: string[], k: string, shift: boolean): string };
  assert.equal(e.addKeyAction('token', ['a'], 'Enter', false), 'add-stay');
  assert.equal(e.addKeyAction('token', ['a'], 'Tab', false), 'add-value');
  assert.equal(e.addKeyAction('token', ['a'], 'Tab', true), 'none', 'Shift+Tab tetap mundur');
  assert.equal(e.addKeyAction('', ['a'], 'Tab', false), 'none', 'kosong: Tab biasa');
  assert.equal(e.addKeyAction(' a ', ['a'], 'Enter', false), 'duplicate');
  assert.equal(e.addKeyAction('a', ['a'], 'Tab', false), 'duplicate');
  assert.equal(e.addKeyAction('x', [], 'a', false), 'none');
});

test('review R13b: input Initial value tidak tertutup oleh blur dari render ulang (state echo)', () => {
  const src = require('node:fs').readFileSync(join(media, 'environment.js'), 'utf8') as string;
  assert.match(src, /inp\.onblur = \(\) => \{ if \(rendering \|\| !inp\.isConnected/, 'blur dari input yang sudah dilepas tidak boleh mereset openNull');
  assert.doesNotMatch(src, /setTimeout\(\(\) => \{ if \(inp\.isConnected\) inp\.focus\(\); \}\)/, 'fokus tidak lagi lewat setTimeout di valueCell (balapan dengan render ulang)');
  assert.match(src, /\.find\(\(r\) => r\.dataset\.key === openNull\)[\s\S]{0,200}\.focus\(\)/, 'render memfokuskan input Initial value yang sedang diisi (openNull) secara sinkron');
});

test('review R16: addKey hanya menulis Environment aktif, key baru ikut ke environment lain saat save (sync)', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(join(__dirname, '..', '..', '..', 'src', 'environmentEditor.ts'), 'utf8') as string;
  const addKeyCase = src.slice(src.indexOf("case 'addKey'"), src.indexOf("case 'renameKey'"));
  assert.ok(addKeyCase.length > 0);
  assert.doesNotMatch(addKeyCase, /updateOthers/, 'addKey tidak boleh menambah key ke environment lain');
});

test('review R17: peringatan di editor saat key di Add variable sudah ada', () => {
  const src = require('node:fs').readFileSync(join(media, 'environment.js'), 'utf8') as string;
  assert.match(src, /add\.oninput = \(\) => \{[\s\S]{0,300}already exists[\s\S]{0,40}\};/, 'oninput menampilkan peringatan key sudah ada');
});

test('review R18: blur karena fokus keluar dari webview tidak menghapus openNull (input Initial value tidak jadi NULL)', () => {
  const src = require('node:fs').readFileSync(join(media, 'environment.js'), 'utf8') as string;
  assert.match(src, /inp\.onblur = \(\) => \{ if \(rendering \|\| !inp\.isConnected \|\| !document\.hasFocus\(\)\) return;/, 'blur akibat window kehilangan fokus diabaikan');
});

test('review R19: blur saat render() mengganti baris (input masih terhubung) tidak menghapus openNull', () => {
  const src = require('node:fs').readFileSync(join(media, 'environment.js'), 'utf8') as string;
  assert.match(src, /let rendering = false;/, 'flag rendering ada');
  assert.match(src, /if \(st\.error\) return;\s*rendering = true;/, 'render menyalakan flag setelah cek error');
  assert.match(src, /rendering = false;\s*\}\);?\s*\}|append\(el\('tr', \{ className: 'add' \}[\s\S]{0,200}rendering = false;/, 'render mematikan flag di akhir');
});

test('review R14: tombol Save di editor Environment & panel request', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  assert.match(fs.readFileSync(join(media, 'environment.html'), 'utf8'), /<button[^>]*id="save"[^>]*title="Save \(Ctrl\+S\)"[^>]*>Save<\/button>/);
  // panel request: Save = ikon (R29 konsep A)
  assert.match(fs.readFileSync(join(media, 'panel.html'), 'utf8'), /<button[^>]*id="save"[^>]*title="Save \(Ctrl\+S\)" aria-label="Save"/);
  for (const f of ['environment.js', 'panel.js']) assert.match(fs.readFileSync(join(media, f), 'utf8'), /\$\('save'\)\.onclick = \(\) => \{[^}]*post\(\{ type: 'save' \}\)/, f);
});
test('review R15: Save (tombol & Ctrl+S) memicu sync key ke semua Environment, Globals tidak', () => {
  const src = (require('node:fs') as typeof import('node:fs')).readFileSync(join(__dirname, '..', '..', '..', 'src', 'envState.ts'), 'utf8');
  assert.match(src, /vscode\.workspace\.onDidSaveTextDocument\(\(d\) => \{\s*const name = this\.nameOf\(d\.uri\);\s*if \(name === undefined \|\| name === GLOBALS\) return;[\s\S]*?this\.sync\(\)/);
});
test('review R20: tombol Save di bawah editor Environment (setelah tabel & catatan)', () => {
  const html = require('node:fs').readFileSync(join(media, 'environment.html'), 'utf8') as string;
  const headEnd = html.indexOf('<div class="head">');
  const saveAt = html.indexOf('id="save"');
  const tableAt = html.indexOf('<table>');
  assert.ok(saveAt > tableAt, 'tombol Save ada setelah tabel');
  assert.ok(html.indexOf('</table>') < saveAt && saveAt > headEnd, 'tombol Save tidak lagi di header');
  assert.ok(html.slice(0, html.indexOf('<div class="msg"')).indexOf('id="save"') === -1, 'tombol Save bukan di header');
});

test('review R21: klik di luar / Enter di kolom Initial value = commit (flush edit, tutup editor NULL)', () => {
  const src = require('node:fs').readFileSync(join(media, 'environment.js'), 'utf8') as string;
  assert.match(src, /function flushEdit\(\) \{[\s\S]{0,200}clearTimeout\(editTimer\)/, 'flushEdit mengirim edit tertunda sekarang');
  assert.match(src, /inp\.onkeydown = \(e\) => \{ if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); inp\.blur\(\); \} \}/, 'Enter di Initial value = commit');
  assert.match(src, /inp\.onblur = \(\) => \{ if \(rendering \|\| !inp\.isConnected \|\| !document\.hasFocus\(\)\) return; flushEdit\(\);/, 'blur (klik di luar) = commit');
});
test('review R22: header tabel (Variable, Initial value, Current value, Secret) tetap terlihat saat scroll', () => {
  const html = require('node:fs').readFileSync(join(media, 'environment.html'), 'utf8') as string;
  assert.match(html, /th \{[^}]*position: sticky;[^}]*top: 0;[^}]*background: var\(--bg\)/);
});

test('review R23: klik Save menampilkan loading lalu notifikasi (host kirim "saved" setelah doc.save)', () => {
  const js = require('node:fs').readFileSync(join(media, 'environment.js'), 'utf8') as string;
  assert.match(js, /\$\('save'\)\.onclick = \(\) => \{ saving = true; render\(\); post\(\{ type: 'save' \}\); \}/, 'klik Save: loading');
  assert.match(js, /\$\('save'\)\.disabled = !st\.dirty \|\| saving;/, 'Save nonaktif saat loading');
  assert.match(js, /\$\('save'\)\.textContent = saving \? 'Saving…' : 'Save';/, 'teks Saving… saat loading');
  assert.match(js, /else if \(m\.type === 'saved'\) \{ saving = false; render\(\); \}/, 'loading selesai saat host membalas');
  const ts = require('node:fs').readFileSync(join(__dirname, '..', '..', '..', 'src', 'environmentEditor.ts'), 'utf8') as string;
  assert.match(ts, /else if \(m\.type === 'save'\) \{[\s\S]{0,300}finally \{ void panel\.webview\.postMessage\(\{ type: 'saved' \}\)/, 'host kirim saved di finally');
  assert.match(ts, /showInformationMessage\(`Environment "\$\{nameOf\(doc\)\}" saved\.`\)/, 'notifikasi sukses');
});
