import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const media = join(__dirname, '../../../media/webview');
const d = createRequire(__filename)(join(media, 'exportDialog.js')) as {
  buildTree(items: { path: string; method?: string }[]): { name: string; children: unknown[]; item?: { path: string } };
  leaves(n: unknown): string[];
  folderState(paths: string[], checked: Set<string>): 'all' | 'some' | 'none';
  extFor(format: string, yaml: boolean): string;
  swapExt(file: string, from: string, to: string): string;
};

test('exportDialog.js: tree bertingkat, folder dulu, leaves, status centang folder', () => {
  const t = d.buildTree([{ path: 'b.http' }, { path: 'api/users/list.http' }, { path: 'api/get.http' }]);
  assert.deepEqual((t.children as { name: string }[]).map((c) => c.name), ['api', 'b.http']);
  assert.deepEqual(d.leaves(t).sort(), ['api/get.http', 'api/users/list.http', 'b.http']);
  assert.equal(d.folderState(['a', 'b'], new Set(['a', 'b'])), 'all');
  assert.equal(d.folderState(['a', 'b'], new Set(['a'])), 'some');
  assert.equal(d.folderState(['a', 'b'], new Set()), 'none');
});

test('exportDialog.js: ekstensi file hasil mengikuti format; Save as kustom tidak ikut berubah', () => {
  assert.equal(d.extFor('postman', false), 'postman_collection.json');
  assert.equal(d.extFor('3.0.3', false), 'openapi.json');
  assert.equal(d.extFor('3.1.0', true), 'openapi.yaml');
  assert.equal(d.swapExt('/w/exports/Shop.postman_collection.json', 'postman_collection.json', 'openapi.yaml'), '/w/exports/Shop.openapi.yaml');
  assert.equal(d.swapExt('/w/custom.txt', 'postman_collection.json', 'openapi.yaml'), '/w/custom.txt');
});

test('exportDialog.html: format, opsi, Save as, tree, peringatan, pratinjau, Export / Cancel', () => {
  const html = readFileSync(join(media, 'exportDialog.html'), 'utf8');
  for (const id of ['format', 'yaml', 'optEnv', 'optJetbrains', 'optScripts', 'optSecrets', 'out', 'browse', 'tree', 'warnings', 'preview', 'go', 'cancel']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /src="exportDialog\.js"/);
});
