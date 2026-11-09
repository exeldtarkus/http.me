import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { deleteWithFallback } from '../../src/trash';

const noTrash = new Error("Unable to delete file 'x' via trash because provider does not support it.");

test('deleteWithFallback: trash berhasil = tidak ada konfirmasi', async () => {
  const calls: boolean[] = [];
  const r = await deleteWithFallback('a', async (_t, trash) => { calls.push(trash); }, async () => { throw new Error('tidak boleh bertanya'); });
  assert.equal(r, 'trash');
  assert.deepEqual(calls, [true]);
});

test('deleteWithFallback: provider tanpa trash (WSL/remote) -> konfirmasi, lalu hapus permanen', async () => {
  const calls: boolean[] = [];
  const del = async (_t: string, trash: boolean) => { calls.push(trash); if (trash) throw noTrash; };
  assert.equal(await deleteWithFallback('a', del, async () => true), 'permanent');
  assert.deepEqual(calls, [true, false]);
});

test('deleteWithFallback: konfirmasi ditolak = tidak dihapus; error lain dilempar ulang', async () => {
  const calls: boolean[] = [];
  assert.equal(await deleteWithFallback('a', async (_t, trash) => { calls.push(trash); throw noTrash; }, async () => false), 'cancelled');
  assert.deepEqual(calls, [true]);
  await assert.rejects(deleteWithFallback('a', async () => { throw new Error('EACCES'); }, async () => true), /EACCES/);
});
