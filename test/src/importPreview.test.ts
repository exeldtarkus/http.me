import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { buildTree, leaves, matches } = createRequire(__filename)(join(__dirname, '../../../media/webview/importPreview.js')) as {
  buildTree(items: { path: string }[]): { name: string; children: unknown[]; item?: { path: string } };
  leaves(n: unknown): string[];
  matches(i: { path: string; method?: string; title?: string; warnings: string[] }, q: string): boolean;
};

test('importPreview.buildTree: folder dulu, lalu file; leaves per folder', () => {
  const t = buildTree([{ path: 'A/b.http' }, { path: 'A/sub/z.http' }, { path: 'A/sub/a.http' }, { path: 'A/_variables.json' }]);
  const a = t.children[0] as { name: string; children: { name: string; item?: unknown }[] };
  assert.equal(a.name, 'A');
  assert.deepEqual(a.children.map((c) => c.name), ['sub', '_variables.json', 'b.http']);
  assert.deepEqual(leaves(a.children[0]), ['A/sub/a.http', 'A/sub/z.http']);
  assert.deepEqual(leaves(t).length, 4);
});

test('importPreview.matches: filter nama / method / judul / peringatan, kosong = semua', () => {
  const it = { path: 'A/pet/addPet.http', method: 'POST', title: 'Add a new pet', warnings: ['GraphQL body converted'] };
  for (const q of ['', 'addpet', 'post', 'new pet', 'graphql']) assert.equal(matches(it, q), true, q);
  assert.equal(matches(it, 'delete'), false);
});
