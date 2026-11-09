import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOrder, ORDER_FILE, parseOrder, readOrder, saveFolderOrder, shiftNames } from '../../src/collectionOrder';

const id = (s: string) => s;

test('applyOrder: nama tersimpan dulu sesuai urutannya, yang tak tercatat di belakang (urutan asal), nama basi diabaikan', () => {
  assert.deepEqual(applyOrder(['a', 'b', 'c', 'd'], id, ['c', 'x', 'a']), ['c', 'a', 'b', 'd']);
  assert.deepEqual(applyOrder(['a', 'b'], id, undefined), ['a', 'b']);
  assert.deepEqual(applyOrder(['a', 'b'], id, []), ['a', 'b']);
});

test('shiftNames: geser satu langkah ke atas / bawah; di ujung tidak berubah', () => {
  assert.deepEqual(shiftNames(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(shiftNames(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(shiftNames(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(shiftNames(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
  assert.deepEqual(shiftNames(['a', 'b'], 'zzz', 1), ['a', 'b']);
});

test('parseOrder: ambil hanya daftar string per folder; JSON rusak = error jelas', () => {
  assert.deepEqual(parseOrder('{"httpmeFormat":1,"order":{"":["a.http"],"api":["x",3,"y"],"bad":"z"}}'), { '': ['a.http'], api: ['x', 'y'] });
  assert.throws(() => parseOrder('{oops', ORDER_FILE), /invalid JSON/);
});

test('readOrder / saveFolderOrder: tulis ke .httpme/order.json, folder lain tetap, daftar kosong menghapus kunci, file tak ada = kosong', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'httpme-order-'));
  try {
    assert.deepEqual(await readOrder(root), {});
    await saveFolderOrder(root, '', ['b.http', 'a.http']);
    await saveFolderOrder(root, 'api', ['z.http']);
    assert.deepEqual(await readOrder(root), { '': ['b.http', 'a.http'], api: ['z.http'] });
    await saveFolderOrder(root, 'api', []);
    assert.deepEqual(await readOrder(root), { '': ['b.http', 'a.http'] });
    assert.match(await fs.readFile(join(root, ORDER_FILE), 'utf8'), /"httpmeFormat": 1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
