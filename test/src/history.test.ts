import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { addHistory, clearHistory, historyEntry, historyView, historyRequestText, historyId, listHistory, removeHistory, HISTORY_MAX } from '../../src/history';
import { parseRequest } from '../../src/httpFile';
import { withTempDir } from './helpers/tmp';

test('historyEntry: header secret & cookie dibuang, body > 64 KB tidak disimpan, teks .http asli ({{var}} tetap)', () => {
  const r = parseRequest('### Login\nPOST {{baseUrl}}/login\nAuthorization: Bearer abc\nCookie: sid=1\nProxy-Authorization: Basic x\nX-Api: {{key}}\n\n{"a":1}\n');
  const e = historyEntry({ id: 'i', time: 5, request: r, env: 'uat', status: 200, ms: 12, file: 'file:///w/a.http' });
  assert.equal(e.text, '### Login\nPOST {{baseUrl}}/login\nX-Api: {{key}}\n\n{"a":1}\n');
  assert.deepEqual({ ...e, text: undefined }, { id: 'i', time: 5, method: 'POST', url: '{{baseUrl}}/login', title: 'Login', env: 'uat', status: 200, ms: 12, file: 'file:///w/a.http', text: undefined });
  const big = historyEntry({ id: 'j', time: 6, request: parseRequest(`POST http://x\n\n${'a'.repeat(64 * 1024 + 1)}\n`), error: 'boom' });
  assert.equal(big.text, 'POST http://x\n');
  assert.equal(big.note, 'Body not saved (larger than 64 KB).');
  assert.equal(big.error, 'boom');
});

test('history: 1 chunk per request 0600, terbaru di atas, prune > 200, remove, clear', () =>
  withTempDir(async (dir) => {
    const r = parseRequest('GET http://x/\n');
    for (let i = 0; i < HISTORY_MAX + 3; i++) await addHistory(dir, historyEntry({ id: historyId(1000 + i, i), time: 1000 + i, request: r, status: 200 }));
    const all = await listHistory(dir);
    assert.equal(all.length, HISTORY_MAX);
    assert.equal(all[0].time, 1000 + HISTORY_MAX + 2, 'terbaru di atas');
    assert.equal(all[all.length - 1].time, 1003, '3 tertua dibuang');
    assert.equal(readdirSync(dir).length, HISTORY_MAX);
    assert.equal(statSync(`${dir}/${readdirSync(dir)[0]}`).mode & 0o777, 0o600);
    await removeHistory(dir, all[0].id);
    assert.equal((await listHistory(dir))[0].time, 1000 + HISTORY_MAX + 1);
    await clearHistory(dir);
    assert.deepEqual(await listHistory(dir), []);
  }));

test('historyId: urut waktu secara teks, unik per Send', () => {
  assert.ok(historyId(999, 1) < historyId(1000, 0));
  assert.notEqual(historyId(5, 1), historyId(5, 2));
});

test('historyEntry: response (contentType + body) disimpan; body response > 64 KB dibuang, contentType tetap', () => {
  const r = parseRequest('GET https://a.test/x\n');
  const ok = historyEntry({ id: 'i', time: 1, request: r, status: 200, file: 'f', response: { contentType: 'application/json', body: '{"a":1}' } });
  assert.deepEqual(ok.response, { contentType: 'application/json', body: '{"a":1}' });
  const big = historyEntry({ id: 'i', time: 1, request: r, status: 200, file: 'f', response: { contentType: 'text/plain', body: 'x'.repeat(65 * 1024) } });
  assert.deepEqual(big.response, { contentType: 'text/plain' });
});

test('historyView: response dari entri History (body JSON dirapikan, status & waktu), error, cancelled, tanpa body', () => {
  const r = parseRequest('GET http://x/a\n');
  const ok = historyView(historyEntry({ id: 'i', time: 1, request: r, status: 200, ms: 25, response: { contentType: 'application/json', body: '{"a":1}' } }), 1 + 5 * 60_000);
  assert.equal(ok.kind, 'response');
  if (ok.kind !== 'response') return;
  assert.equal(ok.status, '200');
  assert.equal(ok.time, '25 ms');
  assert.equal(ok.format, 'JSON');
  assert.match(ok.bodyHtml, /&quot;a&quot;/);
  assert.match(ok.note ?? '', /^From History: executed \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(5 min ago\)\./, 'note memuat tanggal, jam, dan selisih dari sekarang');
  const nobody = historyView(historyEntry({ id: 'j', time: 1, request: r, status: 500, ms: 3 }));
  assert.equal(nobody.kind, 'response');
  const err = historyView(historyEntry({ id: 'k', time: 1, request: r, error: 'ECONNRESET' }), 1 + 2 * 3600_000);
  assert.equal(err.kind, 'error');
  assert.match(err.kind === 'error' ? err.message : '', /^ECONNRESET — from History: executed \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(2 h ago\)$/);
  assert.deepEqual(historyView(historyEntry({ id: 'l', time: 1, request: r, cancelled: true })), { kind: 'cancelled' });
});

test('historyEntry: header response disimpan (Set-Cookie dibuang); historyView menampilkannya', () => {
  const r = parseRequest('GET http://x/a\n');
  const e = historyEntry({ id: 'i', time: 1, request: r, status: 200, ms: 5, response: { contentType: 'text/plain', body: 'hi', headers: [['content-type', 'text/plain'], ['x-id', '7'], ['set-cookie', 'sid=1']] } });
  assert.deepEqual(e.response?.headers, [['content-type', 'text/plain'], ['x-id', '7']]);
  const v = historyView(e);
  assert.deepEqual(v.kind === 'response' ? v.headers : [], [['content-type', 'text/plain'], ['x-id', '7']]);
  assert.doesNotMatch(v.kind === 'response' ? v.note ?? '' : '', /Headers were not saved/);
});

test('historyRequestText: request entri diberi komentar tanggal & jam eksekusi di atasnya, tetap bisa di-parse', () => {
  const e = historyEntry({ id: 'i', time: 1, request: parseRequest('GET http://x/a\nX-A: 1\n') });
  const t = historyRequestText(e, 1 + 3 * 24 * 3600_000);
  assert.match(t, /^# From History: executed \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(3 days ago\)\nGET http:\/\/x\/a\nX-A: 1\n$/);
  assert.equal(parseRequest(t).url, 'http://x/a');
});
