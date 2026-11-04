import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearCache, clearCacheFlow, dirSize, prune, readChunk, readChunks, remove, writeChunk } from '../../src/cache';
import { ttlCache } from '../../src/memo';
import { withTempDir } from './helpers/tmp';

const unix = process.platform !== 'win32';

test('chunk per key: nama di-encode, izin 0600 / folder 0700, dibaca balik', () => withTempDir(async (root) => {
  const dir = join(root, 'history');
  await writeChunk(dir, 'GET https://a/b?x=1', { status: 200 });
  await writeChunk(dir, 'k2', [1, 2]);
  assert.deepEqual(readdirSync(dir).sort(), [`${encodeURIComponent('GET https://a/b?x=1')}.json`, 'k2.json'].sort());
  if (unix) {
    assert.equal(statSync(join(dir, 'k2.json')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  }
  assert.deepEqual(await readChunk(dir, 'GET https://a/b?x=1'), { status: 200 });
  assert.equal(await readChunk(dir, 'missing'), undefined);
  assert.equal(await readChunk(join(root, 'no-dir'), 'k'), undefined);
}));

test('tulis atomik: tulis paralel ke key yang sama tidak meninggalkan file .tmp / JSON setengah jadi', () => withTempDir(async (dir) => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeChunk(dir, 'k', { i, pad: 'x'.repeat(10_000) })));
  assert.deepEqual(readdirSync(dir), ['k.json']);
  assert.equal(typeof ((await readChunk(dir, 'k')) as { i: number }).i, 'number');
}));

test('chunk rusak dilewati saat dibaca, bukan error', () => withTempDir(async (dir) => {
  await writeChunk(dir, 'ok', 1);
  writeFileSync(join(dir, 'bad.json'), '{not json');
  writeFileSync(join(dir, 'x.json.123.tmp'), '{');
  assert.equal(await readChunk(dir, 'bad'), undefined);
  assert.deepEqual(await readChunks(dir), [['ok', 1]]);
  assert.deepEqual(await readChunks(join(dir, 'missing')), []);
}));

test('remove / prune / dirSize / clearCache', () => withTempDir(async (root) => {
  const dir = join(root, 'httpme-cache', 'body');
  for (const k of ['a/1', 'b', 'c']) await writeChunk(dir, k, { k });
  await remove(dir, 'c');
  await remove(dir, 'never');
  assert.deepEqual((await readChunks(dir)).map(([k]) => k).sort(), ['a/1', 'b']);
  await prune(dir, ['a/1', 'not cached']);
  assert.deepEqual((await readChunks(dir)).map(([k]) => k), ['a/1']);
  await prune(join(root, 'missing'), []);
  const cache = join(root, 'httpme-cache');
  assert.ok((await dirSize(cache)) > 5);
  await clearCache(cache);
  assert.equal(await dirSize(cache), 0);
  await clearCache(cache);
  await writeChunk(dir, 'again', 1); // dibuat ulang saat dipakai
  assert.deepEqual(await readChunks(dir), [['again', 1]]);
}));

test('Clear Cache: tampilkan ukuran, batal = tidak dihapus, setuju = folder + ttlCache dikosongkan', () => withTempDir(async (root) => {
  const cache = join(root, 'httpme-cache');
  await writeChunk(join(cache, 'body'), 'k', 'x'.repeat(300_000));
  let calls = 0;
  const memo = ttlCache(60_000);
  await memo.get('env', async () => ++calls);
  const asked: string[] = [];
  assert.equal(await clearCacheFlow(cache, async (mb) => { asked.push(mb); return false; }), undefined);
  assert.deepEqual(asked, ['0.3']);
  assert.ok((await dirSize(cache)) > 0, 'batal: cache tetap ada');
  assert.equal(await memo.get('env', async () => ++calls), 1, 'batal: ttlCache tetap');
  assert.equal(await clearCacheFlow(cache, async () => true), '0.3');
  assert.equal(await dirSize(cache), 0);
  assert.equal(await memo.get('env', async () => ++calls), 2, 'setuju: ttlCache dikosongkan');
}));

test('command http.me: Clear Cache terdaftar', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
  const cmd = pkg.contributes.commands.find((c: { command: string }) => c.command === 'httpme.clearCache');
  assert.deepEqual(cmd && { title: cmd.title, category: cmd.category }, { title: 'Clear Cache', category: 'http.me' });
});
