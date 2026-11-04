import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc, pageJson, webviewPage } from '../../src/webviewPage';

const SRC = join(__dirname, '..', '..', '..', 'src');

test('webviewPage: isi placeholder dari media/webview/<nama>.html', () => {
  const html = webviewPage('whatsNew', { cspSource: 'CSP', installed: '0.0.1', releases: '<i>r</i>' });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /style-src CSP /);
  assert.match(html, /<i>r<\/i>/);
  assert.doesNotMatch(html, /\{\{\w+\}\}/);
});

test('webviewPage: placeholder tanpa nilai = error (bukan halaman setengah jadi)', () => {
  assert.throws(() => webviewPage('whatsNew', { cspSource: 'CSP' }), /whatsNew.*installed/);
});

test('webviewPage: nilai berisi $& / {{x}} tidak diproses ulang', () => {
  const html = webviewPage('whatsNew', { cspSource: '$&', installed: '{{releases}}', releases: 'r' });
  assert.match(html, /style-src \$& /);
  assert.match(html, /<b>\{\{releases\}\}<\/b>/);
});

test('tidak ada halaman HTML utuh di source TypeScript (template di media/webview)', () => {
  const bad = readdirSync(SRC).filter((f) => f.endsWith('.ts') && readFileSync(join(SRC, f), 'utf8').includes('<!DOCTYPE html>'));
  assert.deepEqual(bad, []);
});

test('pageJson: aman di <script type="application/json"> dan bisa di-parse balik', () => {
  const v = { svg: '<svg></svg></script><b>', n: 1, ok: true };
  const s = pageJson(v);
  assert.ok(!s.includes('<'), s);
  assert.deepEqual(JSON.parse(s), v);
});

test('esc: & < > " di-escape', () => {
  assert.equal(esc('a & <b> "c"'), 'a &amp; &lt;b&gt; &quot;c&quot;');
});
