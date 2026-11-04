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

test('review R14: tombol Save di editor Environment & panel request', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  for (const f of ['environment.html', 'panel.html']) {
    assert.match(fs.readFileSync(join(media, f), 'utf8'), /<button[^>]*id="save"[^>]*title="Save \(Ctrl\+S\)"[^>]*>Save<\/button>/, f);
  }
  for (const f of ['environment.js', 'panel.js']) assert.match(fs.readFileSync(join(media, f), 'utf8'), /\$\('save'\)\.onclick = \(\) => \{[^}]*post\(\{ type: 'save' \}\)/, f);
});
