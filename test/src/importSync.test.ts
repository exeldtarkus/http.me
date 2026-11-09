import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { markRemoved, mergeRequest, planResync, sourceFile, parseSource, SOURCE_FILE } from '../../src/importSync';
import { parseRequest } from '../../src/httpFile';
import type { ImportPlan } from '../../src/importCommon';

const old = `### List pets
# @name listPets
# @operation listPets
# @no-redirect
< ./pre.js
GET {{base}}/pets?limit=10
X-Mine: keep
X-Trace: t-1

> ./post.js
`;
const incoming = `### List all pets
# @name listPets
# @operation listPets
# @disabled X-Trace: t-1
# @disabled cursor=abc
# Returns pets.
GET {{base}}/pets?limit=20&sort=asc
X-Api: 2
`;

test('mergeRequest (Update): isi spec baru, edit user dipertahankan (script, flag, header tambahan)', () => {
  const m = parseRequest(mergeRequest(old, incoming));
  assert.equal(m.title, 'List all pets');
  assert.equal(m.url, '{{base}}/pets?limit=20&sort=asc');
  assert.deepEqual(m.preScripts, ['./pre.js']);
  assert.deepEqual(m.postScripts, ['./post.js']);
  assert.equal(m.followRedirects, false);
  assert.ok(m.headers.some((h) => h.name === 'X-Mine' && h.enabled), 'header tambahan user');
  assert.ok(m.headers.some((h) => h.name === 'X-Api' && h.value === '2' && h.enabled), 'header baru dari spec');
  assert.equal(m.headers.find((h) => h.name === 'X-Trace')?.enabled, true, 'status aktif header yang diatur user dipertahankan');
  assert.deepEqual(m.disabledParams, [{ key: 'cursor', value: 'abc' }]);
  assert.equal(m.operation, 'listPets');
});

test('mergeRequest: # @disabled buatan user tetap nonaktif; idempoten', () => {
  const mine = old.replace('X-Trace: t-1', '').replace('X-Mine: keep', 'X-Mine: keep\n# @disabled X-Old: 1');
  const once = mergeRequest(mine, incoming);
  assert.equal(parseRequest(once).headers.find((h) => h.name === 'X-Old')?.enabled, false);
  assert.equal(mergeRequest(once, incoming), once);
});

const plan = (ops: [string, string, string][]): ImportPlan => ({ name: 'A', format: 'openapi', warnings: [], files: ops.map(([path, op, content]) => ({ path, content, warnings: [], operation: op })) });
const req = (op: string, url: string) => `### ${op}\n# @operation ${op}\nGET ${url}\n`;

test('planResync: new / unchanged / update / removed, cocok lewat # @operation (bukan nama file)', () => {
  const existing = [
    { path: 'A/pet/moved-here.http', content: req('getPet', '{{b}}/pet') },
    { path: 'A/pet/same.http', content: req('same', '{{b}}/same') },
    { path: 'A/pet/gone.http', content: req('gone', '{{b}}/gone') },
    { path: 'A/notes.http', content: 'GET https://x.test\n' },
  ];
  const items = planResync(existing, plan([
    ['A/pet/getPet.http', 'getPet', req('getPet', '{{b}}/pets')],
    ['A/pet/same.http', 'same', req('same', '{{b}}/same')],
    ['A/pet/new.http', 'newOp', req('newOp', '{{b}}/n')],
  ]));
  const by = (k: string) => items.filter((i) => i.kind === k).map((i) => i.path);
  assert.deepEqual(by('update'), ['A/pet/moved-here.http']);
  assert.deepEqual(by('unchanged'), ['A/pet/same.http']);
  assert.deepEqual(by('new'), ['A/pet/new.http']);
  assert.deepEqual(by('removed'), ['A/pet/gone.http']);
  assert.match(items.find((i) => i.kind === 'update')!.merged!, /GET \{\{b\}\}\/pets/);
});

test('markRemoved: komentar "Removed in spec", tidak dobel', () => {
  const m = markRemoved(req('gone', '{{b}}/gone'));
  assert.match(m, /# Removed in spec/);
  assert.equal(markRemoved(m), m);
  assert.equal(parseRequest(m).url, '{{b}}/gone');
});

test('_source.json: tulis & baca balik; sumber rusak = error', () => {
  const t = sourceFile({ type: 'url', location: '{{baseUrl}}/openapi.json', format: 'openapi' });
  assert.equal(SOURCE_FILE, '_source.json');
  assert.deepEqual(parseSource(t), { type: 'url', location: '{{baseUrl}}/openapi.json', format: 'openapi' });
  assert.throws(() => parseSource('{"httpmeFormat":1}'), /_source\.json/);
});
