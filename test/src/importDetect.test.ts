import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { detectFormat, parseDoc, safeName } from '../../src/importCommon';

const J = (o: unknown) => JSON.stringify(o);

test('detectFormat: Postman collection v2.0/v2.1, environment, globals', () => {
  assert.equal(detectFormat(J({ info: { name: 'A', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] })).format, 'postman-collection');
  assert.equal(detectFormat(J({ info: { name: 'A', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' }, item: [] })).format, 'postman-collection');
  assert.equal(detectFormat(J({ id: 'x', name: 'Dev', values: [], _postman_variable_scope: 'environment' })).format, 'postman-environment');
  assert.equal(detectFormat(J({ name: 'Globals', values: [], _postman_variable_scope: 'globals' })).format, 'postman-globals');
});

test('detectFormat: Collection v1 ditolak dengan pesan Re-export', () => {
  assert.throws(() => detectFormat(J({ id: 'x', name: 'Old', order: [], requests: [] })), /Re-export as Collection v2\.1/);
});

test('detectFormat: Swagger 2.0, OpenAPI 3.0/3.1 (JSON & YAML), JetBrains env, cURL', () => {
  assert.equal(detectFormat(J({ swagger: '2.0', paths: {} })).format, 'swagger');
  assert.equal(detectFormat(J({ openapi: '3.0.3', paths: {} })).format, 'openapi');
  assert.equal(detectFormat(J({ openapi: '3.1.0', paths: {} })).format, 'openapi');
  assert.equal(detectFormat('openapi: 3.0.0\ninfo:\n  title: A\npaths: {}\n').format, 'openapi');
  assert.equal(detectFormat(J({ dev: { host: 'x' }, prod: { host: 'y' } })).format, 'jetbrains-env');
  assert.equal(detectFormat("curl 'https://a.test' -H 'x: 1'").format, 'curl');
});

test('detectFormat: tidak dikenal / rusak = error yang jelas', () => {
  assert.throws(() => detectFormat('{ not json'), /not a supported/i);
  assert.throws(() => detectFormat(J([1, 2])), /not a supported/i);
  assert.throws(() => detectFormat(J({ foo: 1 })), /not a supported/i);
});

test('parseDoc: JSON tidak memuat modul yaml (lazy); YAML memuatnya', () => {
  const loaded = () => Object.keys(require.cache).some((k) => /node_modules[\\/]yaml[\\/]/.test(k));
  for (const k of Object.keys(require.cache)) if (/node_modules[\\/]yaml[\\/]/.test(k)) delete require.cache[k]; // test lain mungkin sudah memuatnya
  assert.equal(loaded(), false);
  assert.deepEqual(parseDoc('{"a":1}'), { a: 1 });
  assert.equal(loaded(), false, 'JSON tetap parser bawaan');
  assert.deepEqual(parseDoc('a: 1\nb: [x, y]\n'), { a: 1, b: ['x', 'y'] });
  assert.equal(loaded(), true);
});

test('safeName: karakter ilegal diganti, kosong = fallback', () => {
  assert.equal(safeName('GET /pets/{id}?x'), 'GET -pets-{id}-x');
  assert.equal(safeName('  '), 'request');
  assert.equal(safeName('a:b'), 'a-b');
});
