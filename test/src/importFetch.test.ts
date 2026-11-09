import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importAuth, importableFiles } from '../../src/importFetch';
import { importOpenApi } from '../../src/openapi';
import { parseDoc, stringifyDoc } from '../../src/importCommon';

const vals = new Map([['token', 'T0K'], ['key', 'K1']]);

test('importAuth: _auth.http (bearer / apiKey query) diterapkan ke request fetch', () => {
  const b = importAuth('https://a.test/spec.json', '# @auth bearer token={{token}}\n', vals);
  assert.deepEqual(b.headers, [['Authorization', 'Bearer T0K']]);
  const q = importAuth('https://a.test/spec.json', '# @auth apiKey key=api value={{key}} in=query\n', vals);
  assert.equal(q.url, 'https://a.test/spec.json?api=K1');
  assert.deepEqual(importAuth('https://a.test/x', undefined, vals), { url: 'https://a.test/x', headers: [] });
});

test('importAuth: oauth2 / digest ditolak dengan pesan jelas; variable kosong = error', () => {
  assert.throws(() => importAuth('https://a/x', '# @auth oauth2 grant=client_credentials token_url=https://t\n', vals), /OAuth 2\.0/);
  assert.throws(() => importAuth('https://a/x', '# @auth bearer token={{missing}}\n', vals), /missing/i);
});

test('importableFiles: json/yaml/yml saja, .http dikecualikan', () => {
  assert.deepEqual(importableFiles(['file:///a/x.json', 'file:///a/y.YAML', 'file:///a/z.yml', 'file:///a/r.http', 'file:///a/t.txt']), ['file:///a/x.json', 'file:///a/y.YAML', 'file:///a/z.yml']);
});

test('stringifyDoc: JSON & YAML round-trip Petstore; yaml dimuat hanya untuk YAML', () => {
  const doc = parseDoc(readFileSync(join(__dirname, '../../../test/fixtures/import/petstore2.json'), 'utf8'));
  assert.deepEqual(parseDoc(stringifyDoc(doc, 'json')), doc);
  const y = stringifyDoc(doc, 'yaml');
  assert.match(y, /^swagger: "2\.0"/);
  assert.deepEqual(parseDoc(y), doc);
  assert.equal(importOpenApi(parseDoc(y)).files.length, importOpenApi(doc).files.length);
});
