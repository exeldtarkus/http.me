import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { importPostman } from '../../src/postman';
import { buildCollection } from '../../src/exportModel';
import { toPostman, toPostmanEnvironment, validatePostman } from '../../src/exportPostman';
import { untranslateScript, translateScript } from '../../src/postmanScript';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const fixture = () => ({
  info: { name: 'Shop API', schema: SCHEMA },
  variable: [{ key: 'baseUrl', value: 'https://api.shop.test' }, { key: 'tok', value: 'abc' }],
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tok}}', type: 'string' }] },
  event: [{ listen: 'prerequest', script: { exec: ['pm.environment.set("t", 1);'] } }],
  item: [
    {
      name: 'Users', auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p w' }] },
      item: [
        {
          name: 'List users',
          request: {
            method: 'GET', description: 'All users',
            header: [{ key: 'X-Id', value: '7' }, { key: 'X-Off', value: 'z', disabled: true }],
            url: { raw: '{{baseUrl}}/users?page=1&debug=1', host: ['{{baseUrl}}'], path: ['users'], query: [{ key: 'page', value: '1' }, { key: 'debug', value: '1', disabled: true }] },
          },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", function () {', '  pm.response.to.have.status(200);', '});'] } }],
        },
        { name: 'Create user', request: { method: 'POST', auth: { type: 'noauth' }, url: 'https://api.shop.test/users/:id', body: { mode: 'raw', raw: '{"name":"a"}', options: { raw: { language: 'json' } } } } },
      ],
    },
    { name: 'Empty', item: [] },
    { name: 'Login form', request: { method: 'POST', url: { raw: 'https://a.test/login', host: ['a', 'test'], protocol: 'https', path: ['login'] }, body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'a b' }, { key: 'pw', value: '{{pw}}' }] } } },
    { name: 'Upload', request: { method: 'POST', url: 'https://a.test/up', body: { mode: 'formdata', formdata: [{ key: 'title', value: 'hi', type: 'text' }, { key: 'file', type: 'file', src: './a.png' }] } } },
    { name: 'Raw file', request: { method: 'PUT', url: 'https://a.test/bin', body: { mode: 'file', file: { src: './x.bin' } } } },
  ],
});
const filesOf = (p: ReturnType<typeof importPostman>) => p.files.map((f) => ({ path: f.path.replace(/^Shop API\//, ''), content: f.content }));
const exported = () => toPostman(buildCollection('Shop API', filesOf(importPostman(fixture()))), { translateScripts: true });

test('export Postman: struktur v2.1 valid, folder + request + variable', () => {
  const { collection, warnings } = exported();
  assert.deepEqual(validatePostman(collection), []);
  assert.equal(collection.info.schema, SCHEMA);
  assert.deepEqual(collection.variable, [{ key: 'baseUrl', value: 'https://api.shop.test' }, { key: 'tok', value: 'abc' }]);
  assert.deepEqual(collection.item.map((i) => i.name), ['Empty', 'Users', 'Login form', 'Raw file', 'Upload']);
  assert.deepEqual(warnings, []);
});

test('export Postman: URL terurai, query/header nonaktif, auth folder, script diterjemahkan ke pm.*', () => {
  const users = exported().collection.item.find((i) => i.name === 'Users')!;
  assert.deepEqual(users.auth, { type: 'basic', basic: [{ key: 'username', value: 'u', type: 'string' }, { key: 'password', value: 'p w', type: 'string' }] });
  const list = users.item!.find((i) => i.name === 'List users')!;
  assert.equal(list.request!.url.raw, '{{baseUrl}}/users?page=1');
  assert.deepEqual(list.request!.url.query, [{ key: 'page', value: '1' }, { key: 'debug', value: '1', disabled: true }]);
  assert.deepEqual(list.request!.header, [{ key: 'X-Id', value: '7' }, { key: 'X-Off', value: 'z', disabled: true }]);
  assert.deepEqual(list.event![0].script.exec, ['pm.test("ok", function () {', '  pm.response.to.have.status(200);', '});']);
  assert.equal(list.event![0].listen, 'test');
});

test('export Postman: ROUND-TRIP export -> import menghasilkan .http yang sama', () => {
  const first = filesOf(importPostman(fixture()));
  const again = filesOf(importPostman(exported().collection));
  const m = (l: typeof first) => Object.fromEntries(l.map((f) => [f.path, f.content]));
  assert.deepEqual(m(again), m(first));
});

test('export Postman: Environment & Globals, secret kosong default', () => {
  const vars = [{ key: 'a', value: '1' }, { key: 'tok', value: null, secret: true }, { key: 'n', value: null }];
  const e = toPostmanEnvironment('dev', vars, { tok: 'S3' }, { scope: 'environment', includeSecrets: false });
  assert.deepEqual(e.values, [{ key: 'a', value: '1', type: 'default', enabled: true }, { key: 'tok', value: '', type: 'secret', enabled: true }, { key: 'n', value: '', type: 'default', enabled: true }]);
  assert.equal(e._postman_variable_scope, 'environment');
  const g = toPostmanEnvironment('Globals', vars, { tok: 'S3' }, { scope: 'globals', includeSecrets: true });
  assert.equal(g._postman_variable_scope, 'globals');
  assert.equal(g.values[1].value, 'S3');
});

test('untranslateScript: kebalikan tabel, round-trip dengan translateScript', () => {
  const pm = [
    '  pm.expect(pm.response.json().a).to.eql({});', '});', 'pm.collectionVariables.get("c");', 'pm.globals.set("g", 1);', 'pm.variables.get("v");',
    'pm.request.headers.upsert({ key: "K", value: "V" });', 'const t = pm.response.responseTime + pm.response.status;',
  ].join('\n');
  const hm = translateScript(pm).code;
  const back = untranslateScript(hm);
  assert.deepEqual(back.warnings, []);
  assert.equal(back.code, pm);
});

test('untranslateScript: httpme.* tanpa padanan -> komentar + peringatan; komentar not supported tetap', () => {
  const r = untranslateScript('httpme.foo.bar();\n// httpme: not supported — pm.sendRequest: pm.sendRequest(x)');
  assert.match(r.code.split('\n')[0], /^\/\/ pm: not supported/);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.code.split('\n')[1], '// httpme: not supported — pm.sendRequest: pm.sendRequest(x)');
});
