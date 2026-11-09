import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reorderChild } from '../../src/orderCommand';
import { readOrder } from '../../src/collectionOrder';

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'httpme-reorder-'));
  for (const f of ['a.http', 'b.http', 'c.http', 'notes.txt', 'api/x.http', 'api/y.http', 'docs/z.http']) {
    await fs.mkdir(join(root, f, '..'), { recursive: true });
    await fs.writeFile(join(root, f), '');
  }
  return root;
}

test('reorderChild: Move Down / Up pada file; hanya .http yang dihitung, folder & file diurus terpisah', async () => {
  const root = await workspace();
  try {
    assert.equal(await reorderChild(root, 'a.http', { shift: 1 }), true);
    assert.deepEqual((await readOrder(root))[''], ['api', 'docs', 'b.http', 'a.http', 'c.http']);
    assert.equal(await reorderChild(root, 'c.http', { shift: -1 }), true);
    assert.deepEqual((await readOrder(root))[''], ['api', 'docs', 'b.http', 'c.http', 'a.http']);
    assert.equal(await reorderChild(root, 'a.http', { shift: 1 }), false, 'di ujung bawah: tidak ada perubahan');
    assert.equal(await reorderChild(root, 'docs', { shift: -1 }), true);
    assert.deepEqual((await readOrder(root))[''], ['docs', 'api', 'b.http', 'c.http', 'a.http'], 'urutan file tidak hilang saat folder digeser');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('reorderChild: before = taruh sebelum saudara tertentu; di subfolder disimpan di kunci foldernya', async () => {
  const root = await workspace();
  try {
    assert.equal(await reorderChild(root, 'c.http', { before: 'a.http' }), true);
    assert.deepEqual((await readOrder(root))[''], ['api', 'docs', 'c.http', 'a.http', 'b.http']);
    assert.equal(await reorderChild(root, 'api/y.http', { before: 'x.http' }), true);
    assert.deepEqual((await readOrder(root)).api, ['y.http', 'x.http']);
    assert.equal(await reorderChild(root, 'api/y.http', { before: 'y.http' }), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('reorderChild: path di luar root / item tak ada ditolak', async () => {
  const root = await workspace();
  try {
    await assert.rejects(reorderChild(root, '../x.http', { shift: 1 }), /Invalid path/);
    await assert.rejects(reorderChild(root, 'nope.http', { shift: 1 }), /ENOENT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
