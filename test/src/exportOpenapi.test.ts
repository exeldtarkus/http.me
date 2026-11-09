import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importOpenApi } from '../../src/openapi';
import { parseDoc } from '../../src/importCommon';
import { buildCollection } from '../../src/exportModel';
import { schemaOf, toOpenApi, validateOpenApi } from '../../src/exportOpenapi';

const fx = (n: string) => readFileSync(join(__dirname, '../../../test/fixtures/import', n), 'utf8');
const col = (files: { path: string; content: string }[], name = 'Shop') => buildCollection(name, files);
const envs = [{ name: 'dev', values: new Map([['baseUrl', 'https://dev.test/api']]) }, { name: 'prod', values: new Map([['baseUrl', 'https://prod.test']]) }];

test('schemaOf: tipe, objek bersarang, array, format terdeteksi', () => {
  assert.deepEqual(schemaOf({ id: 1, price: 1.5, ok: true, name: 'a', at: '2024-01-01T00:00:00Z', u: '00000000-0000-0000-0000-000000000000', e: 'a@b.co', tags: ['x'], o: { n: null } }, '3.0.3'), {
    type: 'object', properties: {
      id: { type: 'integer' }, price: { type: 'number' }, ok: { type: 'boolean' }, name: { type: 'string' }, at: { type: 'string', format: 'date-time' },
      u: { type: 'string', format: 'uuid' }, e: { type: 'string', format: 'email' }, tags: { type: 'array', items: { type: 'string' } }, o: { type: 'object', properties: { n: { nullable: true } } },
    },
  });
  assert.deepEqual(schemaOf(null, '3.1.0'), { type: 'null' });
  assert.deepEqual(schemaOf([], '3.0.3'), { type: 'array', items: {} });
});

const files = [
  { path: '_auth.http', content: '# @auth bearer token={{token}}\n' },
  { path: 'Users/List.http', content: '### List users\n# @operation listUsers\n# All users\n# @disabled limit=10\nGET {{baseUrl}}/users?page=1\nX-Trace: t\nAccept: application/json\n' },
  { path: 'Users/Get.http', content: '### Get user\nGET {{baseUrl}}/users/42?verbose=1\n' },
  { path: 'Users/Item.http', content: '### Item\nGET {{baseUrl}}/users/{{userId}}/orders/00000000-0000-0000-0000-000000000000\n' },
  { path: 'Users/Create.http', content: '### Create user\n# @auth none\nPOST {{baseUrl}}/users\nContent-Type: application/json\n\n{"name":"a","age":3}\n' },
  { path: 'Users/Q.http', content: '### Q\nQUERY {{baseUrl}}/search\n\nx\n' },
  { path: 'Users/Form.http', content: '### Form\nPOST {{baseUrl}}/login\nContent-Type: application/x-www-form-urlencoded\n\nuser=a&pw=b\n' },
  { path: 'Users/ZDup.http', content: '### Zdup\nGET {{baseUrl}}/users?page=2\n' },
];

test('export OpenAPI 3.0.3: servers, tags, operationId unik, path param, query/header, requestBody, auth', () => {
  const { doc, warnings } = toOpenApi(col(files), { version: '3.0.3', envs, history: [] });
  assert.deepEqual(validateOpenApi(doc), []);
  assert.equal(doc.openapi, '3.0.3');
  assert.equal(doc.info.title, 'Shop');
  assert.deepEqual(doc.servers, [{ url: 'https://dev.test/api', description: 'dev' }, { url: 'https://prod.test', description: 'prod' }]);
  assert.deepEqual(doc.security, [{ bearerAuth: [] }]);
  assert.deepEqual(doc.components.securitySchemes.bearerAuth, { type: 'http', scheme: 'bearer' });
  const list = doc.paths['/users'].get;
  assert.equal(list.operationId, 'listUsers');
  assert.equal(list.summary, 'List users');
  assert.equal(list.description, 'All users');
  assert.deepEqual(list.tags, ['Users']);
  assert.deepEqual(list.parameters, [
    { name: 'page', in: 'query', required: true, schema: { type: 'integer' }, example: 1 },
    { name: 'limit', in: 'query', required: false, schema: { type: 'integer' }, example: 10 },
    { name: 'X-Trace', in: 'header', required: true, schema: { type: 'string' }, example: 't' },
  ]);
  // path param: angka -> {userId} integer, {{userId}} -> {userId}, uuid -> {orderId}
  const get = doc.paths['/users/{userId}'].get;
  assert.deepEqual(get.parameters[0], { name: 'userId', in: 'path', required: true, schema: { type: 'integer' }, example: 42 });
  const item = doc.paths['/users/{userId}/orders/{orderId}'].get;
  assert.deepEqual(item.parameters.map((p: { name: string }) => p.name), ['userId', 'orderId']);
  assert.deepEqual(item.parameters[1].schema, { type: 'string', format: 'uuid' });
  const create = doc.paths['/users'].post;
  assert.deepEqual(create.security, []);
  assert.deepEqual(create.requestBody.content['application/json'].schema, { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } } });
  assert.deepEqual(create.requestBody.content['application/json'].example, { name: 'a', age: 3 });
  assert.deepEqual(doc.paths['/login'].post.requestBody.content['application/x-www-form-urlencoded'].schema, { type: 'object', properties: { user: { type: 'string' }, pw: { type: 'string' } } });
  assert.deepEqual(create.responses, { 200: { description: 'OK' } });
  assert.ok(warnings.some((w) => /QUERY/.test(w)), 'QUERY dilewati + laporan');
  assert.ok(warnings.some((w) => /duplicate/i.test(w)), 'operasi ganda dilewati + laporan');
});

test('export OpenAPI 3.1.0: nullable jadi type array', () => {
  const { doc } = toOpenApi(col(files), { version: '3.1.0', envs: [], history: [] });
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.servers, undefined);
});

test('export OpenAPI: responses dari History (status, contoh, schema)', () => {
  const history = [{ method: 'GET', url: '{{baseUrl}}/users/42?verbose=1', status: 200, contentType: 'application/json', body: '{"id":42,"name":"x"}' }, { method: 'GET', url: '{{baseUrl}}/users/42?verbose=1', status: 404 }];
  const { doc } = toOpenApi(col(files), { version: '3.0.3', envs, history });
  const r = doc.paths['/users/{userId}'].get.responses;
  assert.deepEqual(r[200].content['application/json'].schema, { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } });
  assert.deepEqual(r[200].content['application/json'].example, { id: 42, name: 'x' });
  assert.ok(r[404]);
});

test('export OpenAPI: operationId duplikat diberi akhiran _2', () => {
  const f = [{ path: 'a.http', content: '### A\n# @operation same\nGET /a\n' }, { path: 'b.http', content: '### B\n# @operation same\nGET /b\n' }];
  const { doc } = toOpenApi(col(f), { version: '3.0.3', envs: [], history: [] });
  assert.deepEqual([doc.paths['/a'].get.operationId, doc.paths['/b'].get.operationId], ['same', 'same_2']);
});

test('export OpenAPI: ROUND-TRIP import Petstore -> export -> import (operationId, path, method, tag)', () => {
  for (const name of ['petstore2.json', 'petstore3.yaml']) {
    const p = importOpenApi(parseDoc(fx(name)));
    const c = col(p.files.map((f) => ({ path: f.path.slice(p.name.length + 1), content: f.content })), p.name);
    const { doc } = toOpenApi(c, { version: '3.0.3', envs: [], history: [] });
    assert.deepEqual(validateOpenApi(doc), []);
    const orig = parseDoc(fx(name)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const norm = (s: string) => s.replace(/\{[^}]+\}/g, '{}');
    const ops = (d: Record<string, any>, ref?: Set<string>) => Object.entries(d.paths as Record<string, any>).flatMap(([path, item]) => // eslint-disable-line @typescript-eslint/no-explicit-any
      Object.entries(item).filter(([m]) => ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'].includes(m)).map(([m, o]: [string, any]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const key = norm(`${m} ${path}`);
        return ref ? `${key} ${ref.has(key) ? o.operationId : '*'}` : `${key} ${o.operationId ?? '*'}`;
      })).sort();
    const withId = new Set(Object.entries(orig.paths as Record<string, any>).flatMap(([path, item]) => // eslint-disable-line @typescript-eslint/no-explicit-any
      Object.entries(item).filter(([, o]: [string, any]) => o?.operationId).map(([m]) => norm(`${m} ${path}`)))); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(ops(doc, withId), ops(orig), name);
  }
});

test('export OpenAPI: spec asli (_source.json) mempertahankan tag, requestBody, responses, components bila method + path sama', () => {
  const orig = parseDoc(fx('petstore3.yaml')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const p = importOpenApi(parseDoc(fx('petstore3.yaml')));
  const c = col(p.files.map((f) => ({ path: f.path.slice(p.name.length + 1), content: f.content })), p.name);
  const plain = toOpenApi(c, { version: '3.0.3', envs: [], history: [] }).doc;
  const kept = toOpenApi(c, { version: '3.0.3', envs: [], history: [], original: orig });
  assert.deepEqual(validateOpenApi(kept.doc), []);
  assert.deepEqual(kept.doc.components.schemas, orig.components.schemas);
  const upd = kept.doc.paths['/pet'].put;
  assert.deepEqual(upd.requestBody, orig.paths['/pet'].put.requestBody);
  assert.deepEqual(upd.tags, orig.paths['/pet'].put.tags);
  assert.notDeepEqual(plain.paths['/pet'].put.requestBody, orig.paths['/pet'].put.requestBody, 'tanpa spec asli: diturunkan dari contoh');
});

test('export OpenAPI: path / method berubah dari spec asli -> tidak memakai schema asli; History lebih utama dari responses asli', () => {
  const orig = { openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: { '/a': { get: { operationId: 'getA', tags: ['t'], responses: { 200: { description: 'orig', content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } } } } } }, components: { schemas: { A: { type: 'object' } } } };
  const f = (path: string, extra = '') => [{ path: 'a.http', content: `### A\n# @operation getA\nGET ${path}\n${extra}` }];
  const same = toOpenApi(col(f('/a')), { version: '3.0.3', envs: [], history: [], original: orig }).doc;
  assert.equal(same.paths['/a'].get.responses[200].description, 'orig');
  const moved = toOpenApi(col(f('/b')), { version: '3.0.3', envs: [], history: [], original: orig }).doc;
  assert.equal(moved.paths['/b'].get.responses[200].description, 'OK');
  assert.equal(moved.paths['/b'].get.tags, undefined);
  const hist = toOpenApi(col(f('/a')), { version: '3.0.3', envs: [], history: [{ method: 'GET', url: '/a', status: 201 }], original: orig }).doc;
  assert.deepEqual(Object.keys(hist.paths['/a'].get.responses), ['201']);
});

test('export OpenAPI: spec asli Swagger 2.0 -> tag dipertahankan saja', () => {
  const orig = parseDoc(fx('petstore2.json')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const p = importOpenApi(orig);
  const c = col(p.files.map((f) => ({ path: f.path.slice(p.name.length + 1), content: f.content })), p.name);
  const { doc } = toOpenApi(c, { version: '3.0.3', envs: [], history: [], original: orig });
  assert.deepEqual(validateOpenApi(doc), []);
  assert.deepEqual(doc.paths['/pet'].post.tags, ['pet']);
  assert.equal(doc.components?.schemas, undefined);
});
