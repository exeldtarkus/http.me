import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { runningItems, runningText } from '../../src/runningStatus';
import type { Job } from '../../src/runner';

const job = (id: number, state: 'running' | 'queued', startedAt?: number): Job =>
  ({ id, key: `k${id}`, label: `GET https://a.test/${id}`, state, startedAt, controller: new AbortController() });

test('runningText: jumlah request + durasi request tertua; antrean disebut; kosong = undefined', () => {
  assert.equal(runningText([], 10_000), undefined);
  assert.equal(runningText([job(1, 'running', 7_000)], 10_000), '$(sync~spin) 1 request running · 3s');
  assert.equal(runningText([job(1, 'running', 5_000), job(2, 'running', 9_000), job(3, 'queued')], 10_000), '$(sync~spin) 2 requests running · 5s · 1 queued');
  assert.equal(runningText([job(1, 'running', 10_000)], 75_000), '$(sync~spin) 1 request running · 1m 05s');
});

test('runningItems: berjalan dengan durasi, antre dengan posisi Queued n/m', () => {
  assert.deepEqual(runningItems([job(1, 'running', 8_000), job(2, 'queued'), job(3, 'queued')], 10_000), [
    { id: 1, label: '$(sync~spin) GET https://a.test/1', description: 'running · 2s' },
    { id: 2, label: '$(clock) GET https://a.test/2', description: 'Queued 1/2' },
    { id: 3, label: '$(clock) GET https://a.test/3', description: 'Queued 2/2' },
  ]);
});

test('shortPath: METHOD /path dari URL (origin / {{baseUrl}} dibuang, query tetap)', async () => {
  const { shortPath } = await import('../../src/runningStatus');
  assert.equal(shortPath('https://a.test/pos/log/post?x=1'), '/pos/log/post?x=1');
  assert.equal(shortPath('{{baseUrl}}/pos/log'), '/pos/log');
  assert.equal(shortPath('https://a.test'), '/');
  assert.equal(shortPath('not a url'), 'not a url');
});

test('runningTooltip: satu baris per request (path — Environment · durasi), antre ditandai', async () => {
  const { runningTooltip } = await import('../../src/runningStatus');
  const jobs = [{ ...job(1, 'running', 7_000), label: 'POST https://a.test/pos/log/post', env: 'uat' }, { ...job(2, 'queued'), label: 'GET {{baseUrl}}/x' }];
  assert.equal(runningTooltip(jobs, 10_000), 'POST /pos/log/post — uat · 3s\nGET /x · queued');
});

test('historyItems: ikon status, METHOD /path, deskripsi status · Environment · ago · ms, detail error / file', async () => {
  const { historyItems, ago } = await import('../../src/runningStatus');
  assert.deepEqual([ago(5_000), ago(120_000), ago(2 * 3600_000), ago(3 * 86400_000)], ['just now', '2 min ago', '2 h ago', '3 days ago']);
  const now = 1_000_000_000;
  const items = historyItems([
    { id: 'a', time: now - 120_000, method: 'POST', url: '{{baseUrl}}/pos/log/post', env: 'uat', status: 200, ms: 184, file: 'file:///w/log/page-view.http' },
    { id: 'b', time: now - 1_000, method: 'GET', url: 'https://a.test/x', status: 404, ms: 20 },
    { id: 'c', time: now - 1_000, method: 'GET', url: 'https://a.test/y', error: 'connect ECONNREFUSED' },
    { id: 'd', time: now - 1_000, method: 'DELETE', url: 'https://a.test/z', cancelled: true, env: 'dev' },
  ], now);
  assert.deepEqual(items, [
    { id: 'a', label: '$(pass) POST /pos/log/post', description: '200 · uat · 2 min ago · 184 ms', detail: 'page-view.http' },
    { id: 'b', label: '$(error) GET /x', description: '404 · just now · 20 ms', detail: undefined },
    { id: 'c', label: '$(error) GET /y', description: 'Error · just now', detail: 'connect ECONNREFUSED' },
    { id: 'd', label: '$(circle-slash) DELETE /z', description: 'Cancelled · dev · just now', detail: undefined },
  ]);
});
