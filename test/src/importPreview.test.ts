import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { buildTree, leaves } = createRequire(__filename)(join(__dirname, '../../../media/webview/importPreview.js')) as {
  buildTree(items: { path: string }[]): { name: string; children: unknown[]; item?: { path: string } };
  leaves(n: unknown): string[];
};

test('importPreview.buildTree: folder dulu, lalu file; leaves per folder', () => {
  const t = buildTree([{ path: 'A/b.http' }, { path: 'A/sub/z.http' }, { path: 'A/sub/a.http' }, { path: 'A/_variables.json' }]);
  const a = t.children[0] as { name: string; children: { name: string; item?: unknown }[] };
  assert.equal(a.name, 'A');
  assert.deepEqual(a.children.map((c) => c.name), ['sub', '_variables.json', 'b.http']);
  assert.deepEqual(leaves(a.children[0]), ['A/sub/a.http', 'A/sub/z.http']);
  assert.deepEqual(leaves(t).length, 4);
});
