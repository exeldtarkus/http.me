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
