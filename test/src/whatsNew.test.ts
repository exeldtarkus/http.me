import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASES, isNewerMinor, whatsNewHtml } from '../../src/whatsNew';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));

test('isNewerMinor: hanya naik minor / major yang memunculkan halaman', () => {
  assert.equal(isNewerMinor('0.1.0', undefined), true, 'install baru');
  assert.equal(isNewerMinor('0.2.0', '0.1.5'), true, 'minor naik');
  assert.equal(isNewerMinor('1.0.0', '0.9.3'), true, 'major naik');
  assert.equal(isNewerMinor('0.1.10', '0.1.9'), false, 'patch saja');
  assert.equal(isNewerMinor('0.1.0', '0.1.0'), false, 'versi sama');
  assert.equal(isNewerMinor('0.1.0', '0.2.0'), false, 'downgrade');
  assert.equal(isNewerMinor('0.10.0', '0.9.0'), true, 'bandingkan angka, bukan teks');
});

test('RELEASES: terbaru di atas, tanggal & item terisi, tidak lebih baru dari package.json', () => {
  const num = (v: string) => v.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0);
  assert.ok(RELEASES.length > 0);
  for (let i = 1; i < RELEASES.length; i++) assert.ok(num(RELEASES[i - 1].version) > num(RELEASES[i].version), RELEASES[i].version);
  for (const r of RELEASES) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.items.length > 0, r.version);
  }
  assert.ok(num(RELEASES[0].version) <= num(pkg.version), 'entri terbaru melebihi versi package.json');
});

test('halaman: versi terpasang, rilis terbaru terbuka, lama terlipat, teks di-escape, tanpa script', () => {
  const html = whatsNewHtml('vscode-resource:', '0.2.0', [
    { version: '0.2.0', date: '2026-11-04', items: [{ kind: 'new', title: 'A <b>', detail: 'x & y' }] },
    { version: '0.1.0', date: '2026-11-01', items: [{ kind: 'fixed', title: 'B' }] },
  ]);
  assert.match(html, /Version <b>0\.2\.0<\/b> installed/);
  assert.match(html, /<details open[^>]*>\s*<summary[^>]*>[\s\S]*0\.2\.0/);
  assert.match(html, /<details(?! open)[^>]*>\s*<summary[^>]*>[\s\S]*0\.1\.0/);
  assert.match(html, /A &lt;b&gt;/);
  assert.match(html, /x &amp; y/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /\{\{\w+\}\}/);
});

test("command http.me: What's New terdaftar", () => {
  const cmd = pkg.contributes?.commands?.find((c: { command: string }) => c.command === 'httpme.whatsNew');
  assert.ok(cmd, 'httpme.whatsNew belum ada di contributes.commands');
  assert.equal(cmd.title, "What's New");
  assert.equal(cmd.category, 'http.me');
});
