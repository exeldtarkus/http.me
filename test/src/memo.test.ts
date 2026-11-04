import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { clearAllCaches, ttlCache } from '../../src/memo';

test('ttlCache: pakai ulang sampai kedaluwarsa, fresh memuat ulang, gagal tidak disimpan', async () => {
  let now = 0, calls = 0;
  const cache = ttlCache(1000, () => now);
  const load = async () => ++calls;
  assert.equal(await cache.get('k', load), 1);
  assert.equal(await cache.get('k', load), 1);
  now = 1001;
  assert.equal(await cache.get('k', load), 2);
  // fresh: selalu memuat ulang dan menyimpan hasil terbaru
  assert.equal(await cache.get('k', load, true), 3);
  assert.equal(await cache.get('k', load), 3);
  await assert.rejects(cache.get('bad', async () => { throw new Error('x'); }));
  assert.equal(await cache.get('bad', async () => 7), 7);
  cache.clear();
  assert.equal(await cache.get('k', load), 4);
});

test('ttlCache: request paralel ke key yang sama berbagi satu promise', async () => {
  let calls = 0;
  const cache = ttlCache(1000);
  const load = () => new Promise<number>((ok) => setTimeout(() => ok(++calls), 5));
  assert.deepEqual(await Promise.all([cache.get('k', load), cache.get('k', load)]), [1, 1]);
  assert.equal(calls, 1);
});

test('clearAllCaches: mengosongkan semua ttlCache (Clear Cache)', async () => {
  let calls = 0;
  const a = ttlCache(60_000), b = ttlCache(60_000);
  const load = async () => ++calls;
  await a.get('k', load);
  await b.get('k', load);
  clearAllCaches();
  assert.equal(await a.get('k', load), 3);
  assert.equal(await b.get('k', load), 4);
});
