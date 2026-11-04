import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appliesTo, chainItems, moveItem, ownScript, relScriptPath, withScriptLines, renameEdits, scriptChain, scriptPaths, scriptTemplate, sidecarMoves } from '../../src/scripts';
import { parseRequest } from '../../src/httpFile';
import { withTempDir } from './helpers/tmp';

const put = (root: string, rel: string, text = '') => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };

test('scriptChain: folder teratas → terdekat, lalu baris < / > atas→bawah, duplikat sekali, inline ikut', () =>
  withTempDir(async (root) => {
    put(root, 'pre-request.js'); put(root, 'a/pre-request.js'); put(root, 'a/b/pre-request.js'); put(root, 'a/b/post-request.js');
    put(root, 'a/b/sign.js'); put(root, 'a/s/x.js');
    const http = join(root, 'a/b/req.http');
    const r = parseRequest('< ./sign.js\n< ../s/x.js\n< ./sign.js\n< {% httpme.vars.set("a", 1) %}\nGET http://x\n\n> ./sign.js\n');
    assert.deepEqual(await scriptChain(root, http, r, 'pre'), [
      { file: join(root, 'pre-request.js') }, { file: join(root, 'a/pre-request.js') }, { file: join(root, 'a/b/pre-request.js') },
      { file: join(root, 'a/b/sign.js') }, { file: join(root, 'a/s/x.js') }, { inline: ' httpme.vars.set("a", 1) ' },
    ]);
    assert.deepEqual(await scriptChain(root, http, r, 'post'), [{ file: join(root, 'a/b/post-request.js') }, { file: join(root, 'a/b/sign.js') }]);
  }));

test('scriptChain: @no-scripts / @no-pre / @no-post', () =>
  withTempDir(async (root) => {
    put(root, 'pre-request.js'); put(root, 'post-request.js');
    const http = join(root, 'r.http');
    const chain = (t: string, k: 'pre' | 'post') => scriptChain(root, http, parseRequest(t), k);
    assert.deepEqual(await chain('# @no-scripts\nGET http://x\n', 'pre'), []);
    assert.deepEqual(await chain('# @no-scripts\nGET http://x\n', 'post'), []);
    assert.deepEqual(await chain('# @no-pre\nGET http://x\n', 'pre'), []);
    assert.deepEqual(await chain('# @no-pre\nGET http://x\n', 'post'), [{ file: join(root, 'post-request.js') }]);
    assert.deepEqual(await chain('# @no-post\nGET http://x\n', 'post'), []);
  }));

test('scriptChain: path tidak ada / berkoma = error; .http di luar root hanya folder sendiri', () =>
  withTempDir(async (root) => {
    const http = join(root, 'r.http');
    await assert.rejects(scriptChain(root, http, parseRequest('< ./nope.js\nGET http://x\n'), 'pre'), /Script file not found: \.\/nope\.js/);
    await assert.rejects(scriptChain(root, http, parseRequest('< ./a.js, ./b.js\nGET http://x\n'), 'pre'), /one script path per line/);
    put(root, 'out/pre-request.js'); put(root, 'pre-request.js');
    assert.deepEqual(await scriptChain(join(root, 'ws'), join(root, 'out/r.http'), parseRequest('GET http://x\n'), 'pre'), [{ file: join(root, 'out/pre-request.js') }]);
  }));

test('scriptPaths: posisi path di baris < / >, jenis pre / body / post per blok, inline dilewati', () => {
  const text = [
    '### a',          // 0
    '<  ./sign.js',   // 1
    '< {% x %}',      // 2
    'POST http://x',  // 3
    '',               // 4
    '< ./body.json',  // 5
    '',               // 6
    '> ./save.js ',   // 7
    '> {%',           // 8
    '< ./no.js',      // 9 (di dalam inline)
    '%}',             // 10
    '### b',          // 11
    '< ../pre.js',    // 12
    'GET http://y',   // 13
  ].join('\n');
  assert.deepEqual(scriptPaths(text), [
    { path: './sign.js', line: 1, start: 3, end: 12, kind: 'pre' },
    { path: './body.json', line: 5, start: 2, end: 13, kind: 'body' },
    { path: './save.js', line: 7, start: 2, end: 11, kind: 'post' },
    { path: '../pre.js', line: 12, start: 2, end: 11, kind: 'pre' },
  ]);
});

test('relScriptPath: relatif ke folder .http, selalu diawali ./ atau ../, pemisah /', () => {
  assert.equal(relScriptPath('/w/a/b', '/w/a/b/s.js'), './s.js');
  assert.equal(relScriptPath('/w/a/b', '/w/a/x/s.js'), '../x/s.js');
  assert.equal(relScriptPath('/w/a', '/w/a/x/y/s.js'), './x/y/s.js');
});

test('renameEdits: path yang menunjuk file (atau folder) lama ditulis ulang relatif ke .http, path lain tidak', () => {
  const text = '< ./sign.js\n< ../s/sign.js\nGET http://x\n\n< ./lib/body.json\n\n> ./lib/save.js\n';
  assert.deepEqual(renameEdits(text, '/w/a', '/w/a/sign.js', '/w/a/scripts/sign2.js'), [{ line: 0, start: 2, end: 11, text: './scripts/sign2.js' }]);
  assert.deepEqual(renameEdits(text, '/w/a', '/w/a/lib', '/w/lib2'), [
    { line: 4, start: 2, end: 17, text: '../lib2/body.json' },
    { line: 6, start: 2, end: 15, text: '../lib2/save.js' },
  ]);
  assert.deepEqual(renameEdits(text, '/w/a', '/w/zzz.js', '/w/y.js'), []);
});

test('scriptTemplate: pre / post berisi komentar + contoh API, JS valid', () => {
  const vm = require('node:vm') as typeof import('node:vm');
  for (const k of ['pre', 'post'] as const) assert.doesNotThrow(() => new vm.Script(scriptTemplate(k)));
  assert.match(scriptTemplate('pre'), /Before request/);
  assert.match(scriptTemplate('post'), /After response/);
});

test('script milik request <nama>.pre-request.js / .post-request.js: otomatis, urutan terakhir', () =>
  withTempDir(async (root) => {
    put(root, 'pre-request.js'); put(root, 'sign.js'); put(root, 'r.pre-request.js'); put(root, 'r.post-request.js');
    const http = join(root, 'r.http');
    assert.equal(ownScript(http, 'pre'), join(root, 'r.pre-request.js'));
    assert.deepEqual(await scriptChain(root, http, parseRequest('< ./sign.js\nGET http://x\n'), 'pre'),
      [{ file: join(root, 'pre-request.js') }, { file: join(root, 'sign.js') }, { file: join(root, 'r.pre-request.js') }]);
    assert.deepEqual(await scriptChain(root, http, parseRequest('GET http://x\n> ./r.post-request.js\n'), 'post'), [{ file: join(root, 'r.post-request.js') }], 'sekali saja');
    assert.deepEqual(await scriptChain(root, join(root, 'other.http'), parseRequest('GET http://x\n'), 'post'), []);
  }));

test('sidecarMoves: rename / pindah .http ikut memindahkan script miliknya', () => {
  assert.deepEqual(sidecarMoves('/w/a/r.http', '/w/b/page.http'), [
    ['/w/a/r.pre-request.js', '/w/b/page.pre-request.js'],
    ['/w/a/r.post-request.js', '/w/b/page.post-request.js'],
  ]);
  assert.deepEqual(sidecarMoves('/w/a/r.txt', '/w/a/r.http'), []);
});

test('appliesTo: jumlah request (blok) .http di folder script & subfolder, kecuali @no-scripts / @no-pre / @no-post', () => {
  const files = [
    { path: '/w/a/r1.http', text: 'GET http://x\n' },
    { path: '/w/a/b/r2.http', text: '### one\nGET http://x\n\n### two\n# @no-pre\nGET http://y\n' },
    { path: '/w/a/r3.http', text: '# @no-scripts\nGET http://x\n' },
    { path: '/w/ab/r4.http', text: 'GET http://x\n' },
    { path: '/w/r5.http', text: 'GET http://x\n' },
  ];
  assert.equal(appliesTo('/w/a/pre-request.js', files), 2);
  assert.equal(appliesTo('/w/a/post-request.js', files), 3);
  assert.equal(appliesTo('/w/pre-request.js', files), 4);
});

test('moveItem: pindah urutan (◀ ▶ / drag), indeks di luar batas = tidak berubah', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
});

test('withScriptLines: path relatif satu per baris, < sebelum baris request, > setelah body, dibuat / dihapus; inline tetap', async () => {
  const { serializeRequest } = await import('../../src/httpFile');
  const r = parseRequest('### t\n< ./old.js\n< {% x %}\nPOST http://x\nA: 1\n\n{}\n');
  const a = withScriptLines(r, 'pre', '/w/a', ['/w/a/s/sign.js', '/w/lib/x.js']);
  const b = withScriptLines(a, 'post', '/w/a', ['/w/a/save.js']);
  assert.equal(serializeRequest(b), '### t\n< ./s/sign.js\n< ../lib/x.js\n< {% x %}\nPOST http://x\nA: 1\n\n{}\n\n> ./save.js\n');
  const c = withScriptLines(withScriptLines(b, 'pre', '/w/a', []), 'post', '/w/a', []);
  assert.equal(serializeRequest(c), '### t\n< {% x %}\nPOST http://x\nA: 1\n\n{}\n');
});

test('chainItems: daftar Runs in order (folder → baris < / > → This request), file tidak ada tetap tampil', () =>
  withTempDir(async (root) => {
    put(root, 'pre-request.js'); put(root, 'a/sign.js');
    const http = join(root, 'a/r.http');
    const r = parseRequest('< ./sign.js\n< ./nope.js\n< {% x %}\nGET http://x\n');
    assert.deepEqual(await chainItems(root, http, r, 'pre'), [
      { file: join(root, 'pre-request.js'), source: 'folder', exists: true },
      { file: join(root, 'a/sign.js'), source: 'line', exists: true },
      { file: join(root, 'a/nope.js'), source: 'line', exists: false },
      { file: '', source: 'inline', exists: true, code: ' x ' },
      { file: join(root, 'a/r.pre-request.js'), source: 'own', exists: false },
    ]);
  }));
