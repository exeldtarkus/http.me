import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { join } from 'node:path';

type Param = { key: string; value: string; enabled: boolean };
// panel.js = JS vanilla webview; fungsi murninya diekspor lewat module.exports saat di-require di Node
const panel = require(join(__dirname, '..', '..', '..', 'media', 'webview', 'panel.js')) as {
  urlToParams(url: string): Param[];
  paramsToUrl(url: string, params: Param[]): string;
  tokenClass(name: string, vars: Vars, file: string[]): string;
  segments(text: string, vars: Vars, file: string[]): { text: string; name?: string; cls?: string }[];
  completionPrefix(before: string): string | undefined;
};
type Vars = { ok: string[]; nulls: string[]; names: string[] };

test('urlToParams: query URL jadi baris Params (nilai mentah, {{var}} utuh)', () => {
  assert.deepEqual(panel.urlToParams('https://a.test/p?x=1&user={{username}}&flag&e=a%20b#top'), [
    { key: 'x', value: '1', enabled: true },
    { key: 'user', value: '{{username}}', enabled: true },
    { key: 'flag', value: '', enabled: true },
    { key: 'e', value: 'a%20b', enabled: true },
  ]);
  assert.deepEqual(panel.urlToParams('https://a.test/p'), []);
  assert.deepEqual(panel.urlToParams('{{baseUrl}}/p?q=a=b'), [{ key: 'q', value: 'a=b', enabled: true }]);
});

test('paramsToUrl: Params aktif ditulis ulang ke URL, fragment & base tetap; nonaktif tidak masuk URL', () => {
  const params: Param[] = [
    { key: 'x', value: '2', enabled: true },
    { key: 'debug', value: 'true', enabled: false },
    { key: 'flag', value: '', enabled: true },
    { key: '', value: '', enabled: true },
  ];
  assert.equal(panel.paramsToUrl('https://a.test/p?old=1#top', params), 'https://a.test/p?x=2&flag#top');
  assert.equal(panel.paramsToUrl('https://a.test/p?old=1', []), 'https://a.test/p');
  assert.equal(panel.paramsToUrl('{{baseUrl}}/p', [{ key: 'q', value: '{{v}}', enabled: true }]), '{{baseUrl}}/p?q={{v}}');
});

test('URL ↔ Params bolak-balik tanpa perubahan', () => {
  for (const url of ['https://a.test/p?x=1&y=2', 'https://a.test/?a&b', '{{base}}/x?q={{q}}#f']) {
    assert.equal(panel.paramsToUrl(url, panel.urlToParams(url)), url);
  }
});

type Header = { name: string; value: string; enabled: boolean };
type Req = { headers: Header[]; body: string; bodyType: string };
const body = panel as unknown as {
  setBodyType(req: Req, type: string): void;
  formToRows(body: string): Param[];
  rowsToForm(rows: Param[]): string;
};
const ct = (r: Req) => r.headers.filter((h) => h.enabled && h.name.toLowerCase() === 'content-type').map((h) => h.value);

test('setBodyType: JSON / text / XML / form mengatur Content-Type (satu saja), none menghapus header + body', () => {
  const r: Req = { headers: [{ name: 'Accept', value: '*/*', enabled: true }], body: '{"a":1}', bodyType: 'text' };
  body.setBodyType(r, 'json');
  assert.deepEqual(ct(r), ['application/json']);
  assert.equal(r.bodyType, 'json');
  r.headers.find((h) => h.name === 'Content-Type')!.value = 'application/json; charset=utf-8';
  body.setBodyType(r, 'json');
  assert.deepEqual(ct(r), ['application/json; charset=utf-8'], 'jenis sama: nilai user dipertahankan');
  body.setBodyType(r, 'xml');
  assert.deepEqual(ct(r), ['application/xml']);
  body.setBodyType(r, 'text');
  assert.deepEqual(ct(r), ['text/plain']);
  body.setBodyType(r, 'form');
  assert.deepEqual(ct(r), ['application/x-www-form-urlencoded']);
  assert.equal(r.body, '{"a":1}', 'ganti jenis tidak menghapus body');
  body.setBodyType(r, 'none');
  assert.deepEqual(ct(r), []);
  assert.equal(r.body, '');
  assert.equal(r.bodyType, 'none');
  assert.deepEqual(r.headers.map((h) => h.name), ['Accept']);
});

test('x-www-form-urlencoded: body ↔ baris key/value, {{var}} tidak di-encode', () => {
  assert.deepEqual(body.formToRows('a=1&b=x%20y&e+f=g+h&flag&bad=%E0&v={{token}}'), [
    { key: 'a', value: '1', enabled: true },
    { key: 'b', value: 'x y', enabled: true },
    { key: 'e f', value: 'g h', enabled: true },
    { key: 'flag', value: '', enabled: true },
    { key: 'bad', value: '%E0', enabled: true },
    { key: 'v', value: '{{token}}', enabled: true },
  ]);
  assert.equal(body.rowsToForm([
    { key: 'name', value: 'a b&c=d', enabled: true },
    { key: 'off', value: '1', enabled: false },
    { key: 'v', value: 'x{{token}}y', enabled: true },
    { key: '', value: '', enabled: true },
  ]), 'name=a%20b%26c%3Dd&v=x{{token}}y');
  assert.deepEqual(body.formToRows(''), []);
});

const vars: Vars = { ok: ['baseUrl'], nulls: ['apiKey'], names: ['apiKey', 'baseUrl'] };

test('token panel: warna ok / NULL / tidak ada / dinamis (variabel file = ok); ikut Environment aktif', () => {
  assert.deepEqual(['baseUrl', 'apiKey', 'nope', '$guid', '$nope', 'host'].map((n) => panel.tokenClass(n, vars, ['host'])), ['ok', 'null', 'missing', 'dyn', 'missing', 'ok']);
  // ganti Environment: host mengirim daftar baru, warna ikut
  assert.equal(panel.tokenClass('apiKey', { ok: ['apiKey'], nulls: [], names: [] }, []), 'ok');
});

test('token panel: segments memotong teks field jadi teks biasa + token (posisi utuh untuk mirror)', () => {
  const segs = panel.segments('{{baseUrl}}/x?k={{ apiKey }}&r={{$randomInt 1 9}}', vars, []);
  assert.deepEqual(segs, [
    { text: '{{baseUrl}}', name: 'baseUrl', cls: 'ok' }, { text: '/x?k=' }, { text: '{{ apiKey }}', name: 'apiKey', cls: 'null' },
    { text: '&r=' }, { text: '{{$randomInt 1 9}}', name: '$randomInt', cls: 'dyn' },
  ]);
  assert.equal(segs.map((x) => x.text).join(''), '{{baseUrl}}/x?k={{ apiKey }}&r={{$randomInt 1 9}}');
  assert.deepEqual(panel.segments('plain', vars, []), [{ text: 'plain' }]);
});

test('autocomplete {{ di panel: awalan nama sebelum kursor', () => {
  assert.equal(panel.completionPrefix('GET {{'), '');
  assert.equal(panel.completionPrefix('GET {{ bas'), 'bas');
  assert.equal(panel.completionPrefix('GET {{base}}/x'), undefined);
  assert.equal(panel.completionPrefix('x {'), undefined);
});

test('tab Scripts: insertAt (snippet / Tab di kursor, menggantikan seleksi) + nomor baris', () => {
  const p = panel as unknown as { insertAt(t: string, s: number, e: number, ins: string): { text: string; caret: number }; lineNumbers(t: string): string };
  assert.deepEqual(p.insertAt('ab\ncd', 3, 3, 'x();\n'), { text: 'ab\nx();\ncd', caret: 8 });
  assert.deepEqual(p.insertAt('abcd', 1, 3, '  '), { text: 'a  d', caret: 3 });
  assert.equal(p.lineNumbers('a\nb\n'), '1\n2\n3');
  assert.equal(p.lineNumbers(''), '1');
});
