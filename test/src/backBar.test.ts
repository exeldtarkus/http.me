import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenedSet } from '../../src/backBarState';
import { webviewPage } from '../../src/webviewPage';

test('OpenedSet: tandai, cek, lepas yang sudah tertutup, beri tahu perubahan sekali per perubahan', () => {
  const calls: string[][] = [];
  const s = new OpenedSet((list) => calls.push(list));
  s.add('/a/get.http'); s.add('/a/get.http'); s.add('/b/dev.json');
  assert.equal(s.has('/a/get.http'), true);
  assert.equal(s.has('/zzz'), false);
  assert.deepEqual(calls, [['/a/get.http'], ['/a/get.http', '/b/dev.json']], 'add ganda tidak memicu event');
  s.prune(new Set(['/b/dev.json']));
  assert.deepEqual(calls[2], ['/b/dev.json']);
  s.prune(new Set(['/b/dev.json']));
  assert.equal(calls.length, 3, 'tanpa perubahan tidak ada event');
});

test('OpenedSet.delete: melepas satu key dan memberi tahu', () => {
  const calls: string[][] = [];
  const s = new OpenedSet((l) => calls.push(l));
  s.add('x'); s.delete('x'); s.delete('x');
  assert.deepEqual(calls, [['x'], []]);
});

test('webviewPage: halaman request / Environment / All Environments menyertakan bar Back to Dashboard (include + script)', () => {
  for (const name of ['panel', 'environment', 'compare']) {
    const html = webviewPage(name, { cspSource: 'csp', nonce: 'n' });
    assert.match(html, /id="backBar"/, name);
    assert.match(html, /Back to Dashboard/, name);
    assert.ok(html.indexOf('window.acquireVsCodeApi') < html.indexOf('acquireVsCodeApi()'), `${name}: wrapper dipasang sebelum halaman memanggil acquireVsCodeApi`);
    assert.ok(!html.includes('<!--include:'), name);
  }
});

test('backbar.js: tombol dengan ikon panah + label, tooltip jelas', () => {
  const html = readFileSync(join(__dirname, '../../../media/webview/backbar.html'), 'utf8');
  assert.match(html, /title="Back to Dashboard"/);
  assert.match(html, /<svg/);
  assert.match(html, />Dashboard</);
});
