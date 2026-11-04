import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('request panel Flight deck: Send idle berikon SVG saja, Cancel berlabel teks', () => {
  const dir = join(__dirname, '..', '..', '..', 'media', 'webview');
  const html = readFileSync(join(dir, 'panel.html'), 'utf8');
  const js = readFileSync(join(dir, 'panel.js'), 'utf8');
  const send = html.match(/<button[^>]*id="send"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(send, /aria-label="Send request"/);
  assert.match(send, /title="Send \(Ctrl\+Enter\)"/);
  assert.match(send, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(send.replace(/<svg[\s\S]*?<\/svg>/, ''), />\s*Send\s*</);
  assert.match(js, /Cancel request/);
  assert.match(js, /Cancel \(Escape\)/);
  assert.match(js, /Send request/);
  assert.match(js, /Send \(Ctrl\+Enter\)/);
});

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

test('loadingState: running / queued / cancelling / selesai (label tahap, sub-teks, tombol Cancel)', () => {
  const p = panel as unknown as { loadingState(view: unknown, cancelling: boolean): { hidden: boolean; text: string; sub: string; cancel: string; disabled: boolean } };
  assert.deepEqual(p.loadingState({ kind: 'running', label: 'POST /pos/log/post · uat' }, false), { hidden: false, text: 'Sending request', sub: 'POST /pos/log/post · uat', cancel: 'Cancel', disabled: false });
  assert.deepEqual(p.loadingState({ kind: 'running', label: 'GET /x', stage: 'Following redirect 2/10' }, false).text, 'Following redirect 2/10');
  assert.deepEqual(p.loadingState({ kind: 'queued', label: 'GET /x', position: 'Queued 2/8' }, false).text, 'Queued 2/8');
  assert.deepEqual(p.loadingState({ kind: 'running', label: 'GET /x' }, true), { hidden: false, text: 'Sending request', sub: 'GET /x', cancel: 'Cancelling…', disabled: true });
  assert.equal(p.loadingState({ kind: 'response' }, false).hidden, true);
  assert.equal(p.loadingState(undefined, false).hidden, true);
});

test('othersText: loading sebaris untuk request di tab lain', () => {
  const p = panel as unknown as { othersText(n: number): string };
  assert.deepEqual([p.othersText(0), p.othersText(1), p.othersText(3)], ['', '1 other request running', '3 other requests running']);
});

test('review R1/R2: petunjuk di bawah URL diganti popup bantuan; daftar pilihan select mengikuti tema', () => {
  const html = require('node:fs').readFileSync(join(__dirname, '..', '..', '..', 'media', 'webview', 'panel.html'), 'utf8') as string;
  assert.ok(!html.includes('<p class="hint">'), 'teks petunjuk di bawah URL dihapus');
  assert.match(html, /id="help"[^>]*aria-describedby="helpPop"/);
  assert.match(html, /id="helpPop" role="tooltip"[\s\S]*curl …[\s\S]*Ctrl\+Enter[\s\S]*\{\{/);
  assert.match(html, /\.help:hover > \.helppop, \.help:focus-within > \.helppop \{ display: block/);
  assert.match(html, /option \{ background-color: var\(--vscode-dropdown-background/);
  assert.match(html, /body\.vscode-dark \{ color-scheme: dark; \}/);
  assert.doesNotMatch(html, /grid-template-rows: auto auto auto minmax/, 'baris grid petunjuk ikut dihapus');
});

test('review R3: clampSplit menjaga tinggi request & response minimum saat batas di-drag', () => {
  const p = panel as unknown as { clampSplit(h: number, total: number): number };
  assert.equal(p.clampSplit(300, 800), 300);
  assert.equal(p.clampSplit(20, 800), 80, 'request minimal 80 px');
  assert.equal(p.clampSplit(790, 800), 680, 'response minimal 120 px');
  assert.equal(p.clampSplit(500, 150), 80, 'jendela terlalu pendek: request tetap 80 px');
});

test('review R3/R4: sash bisa di-drag (separator), scrollbar ikut tema, toolbar Body punya Beautify', () => {
  const html = require('node:fs').readFileSync(join(__dirname, '..', '..', '..', 'media', 'webview', 'panel.html'), 'utf8') as string;
  assert.match(html, /<div class="sash" id="sash" role="separator" aria-orientation="horizontal"[^>]*tabindex="0"/);
  assert.match(html, /::-webkit-scrollbar-thumb \{ background: var\(--vscode-scrollbarSlider-background/);
  assert.match(html, /<button[^>]*id="beautify"[^>]*>Beautify<\/button>/);
  assert.match(html, /\.reqpanes > \.pane \{ flex: 1 1 auto;/);
});

test('review R5: defaultScript = script pertama yang jalan (file ada / inline), This request bila belum ada script', () => {
  const p = panel as unknown as { defaultScript(items: { file: string; source: string; exists: boolean }[]): { file: string } | undefined };
  const own = { file: '/w/r.pre-request.js', source: 'own', exists: false };
  assert.equal(p.defaultScript([{ file: '/w/pre-request.js', source: 'folder', exists: true }, { file: '/w/a.js', source: 'line', exists: true }, own])?.file, '/w/pre-request.js');
  assert.equal(p.defaultScript([{ file: '/w/nope.js', source: 'line', exists: false }, { file: '/w/a.js', source: 'line', exists: true }, own])?.file, '/w/a.js', 'file yang tidak ada dilewati');
  assert.equal(p.defaultScript([{ file: '', source: 'inline', exists: true }, own])?.file, '', 'inline ikut');
  assert.equal(p.defaultScript([own]), own, 'belum ada script: This request (kosong)');
  assert.equal(p.defaultScript([{ file: '/w/r.pre-request.js', source: 'own', exists: true }])?.file, '/w/r.pre-request.js');
});

test('review R6: urutan Tab tabel key/value = Key → Value → ✕ → Key baris berikutnya', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const dir = join(__dirname, '..', '..', '..', 'media', 'webview');
  assert.match(fs.readFileSync(join(dir, 'panel.html'), 'utf8'), /\.kv tr:hover \.del, \.kv tr:focus-within \.del \{ visibility: visible; \}/);
  assert.match(fs.readFileSync(join(dir, 'panel.js'), 'utf8'), /el\('input', \{ type: 'checkbox', checked: row\.enabled, title: '[^']*', tabIndex: -1 \}\)/);
});

test('review R7: body form / none menyembunyikan pembungkus editor teks (bukan hanya textarea)', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const dir = join(__dirname, '..', '..', '..', 'media', 'webview');
  // .vwrap.area { display: flex } punya bobot sama: aturan hidden harus lebih kuat
  assert.match(fs.readFileSync(join(dir, 'panel.html'), 'utf8'), /\.vwrap\[hidden\], \.vwrap\.area\[hidden\] \{ display: none; \}/);
  assert.match(fs.readFileSync(join(dir, 'panel.js'), 'utf8'), /\$\('bodyText'\)\.closest\('\.vwrap'\)\.hidden = \$\('bodyText'\)\.hidden;/);
});

test('review R8: highlightJs mewarnai keyword / string / angka / komentar / fungsi / httpme, teks di-escape, isi tidak berubah', () => {
  const p = panel as unknown as { highlightJs(code: string): string };
  const code = "// note <b>\nconst x = await httpme.response.json(); /* a */\nif (x.n > 2) console.log(`t ${x}`, 'q\\'s', 1.5e3);\n";
  const html = p.highlightJs(code);
  assert.match(html, /<span class="j-c">\/\/ note &lt;b&gt;<\/span>/);
  assert.match(html, /<span class="j-k">const<\/span> x = <span class="j-k">await<\/span> <span class="j-h">httpme<\/span>\.response\.<span class="j-f">json<\/span>\(\);/);
  assert.match(html, /<span class="j-c">\/\* a \*\/<\/span>/);
  assert.match(html, /<span class="j-k">if<\/span> \(x\.n &gt; <span class="j-n">2<\/span>\)/);
  assert.match(html, /<span class="j-s">`t \$\{x\}`<\/span>, <span class="j-s">'q\\'s'<\/span>, <span class="j-n">1\.5e3<\/span>/);
  const text = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(text, code, 'tanpa tag = teks asli (posisi karakter sama dengan textarea)');
});

test('review R9: tombol Copy di bar response', () => {
  const html = require('node:fs').readFileSync(join(__dirname, '..', '..', '..', 'media', 'webview', 'panel.html'), 'utf8') as string;
  assert.match(html, /<button[^>]*id="copyBody"[^>]*aria-label="Copy response body"[^>]*><svg[\s\S]*?<\/svg><\/button>/, 'R10: ikon saja');
});

test('review R12: tombol hapus / lepas memakai ikon tempat sampah, bukan ✕', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const dir = join(__dirname, '..', '..', '..', 'media', 'webview');
  for (const f of ['panel.js', 'environment.js']) {
    const js = fs.readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(js, /textContent: '✕'/, f);
    assert.match(js, /const TRASH = '<svg/, f);
  }
  const pkg = JSON.parse(fs.readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
  assert.equal(pkg.contributes.commands.find((c: { command: string }) => c.command === 'httpme.clearCookies').icon, '$(trash)');
});
