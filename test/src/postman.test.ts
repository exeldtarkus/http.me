import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { ImportPlan } from '../../src/importCommon';
import { importPostman } from '../../src/postman';
import { parseRequest } from '../../src/httpFile';
import { parseEnvironment } from '../../src/environments';

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
        {
          name: 'Create user', request: {
            method: 'POST', auth: { type: 'noauth' },
            url: 'https://api.shop.test/users/:id',
            body: { mode: 'raw', raw: '{"name":"a"}', options: { raw: { language: 'json' } } },
          },
        },
      ],
    },
    { name: 'Login form', request: { method: 'POST', url: { raw: 'https://a.test/login', host: ['a', 'test'], protocol: 'https', path: ['login'] }, body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'a b' }, { key: 'pw', value: '{{pw}}' }, { key: 'x', value: '1', disabled: true }] } } },
    { name: 'Upload', request: { method: 'POST', url: 'https://a.test/up', body: { mode: 'formdata', formdata: [{ key: 'title', value: 'hi', type: 'text' }, { key: 'file', type: 'file', src: './a.png' }] } } },
    { name: 'Raw file', request: { method: 'PUT', url: 'https://a.test/bin', body: { mode: 'file', file: { src: './x.bin' } } } },
    { name: 'GQL', request: { method: 'POST', url: 'https://a.test/gql', body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } } } },
    { name: 'Odd', request: { method: 'PROPFIND', url: 'https://a.test/x' } },
  ],
});
const plan = () => importPostman(fixture());
const file = (p: ImportPlan, path: string) => p.files.find((f) => f.path === path);

test('importPostman: struktur folder + nama file aman', () => {
  const p = plan();
  assert.equal(p.name, 'Shop API');
  assert.deepEqual(p.files.map((f) => f.path).sort(), [
    'Shop API/GQL.http', 'Shop API/Login form.http', 'Shop API/Raw file.http', 'Shop API/Upload.http', 'Shop API/Users/List users.http',
    'Shop API/Users/List users.post-request.js', 'Shop API/Users/Create user.http', 'Shop API/Users/_auth.http', 'Shop API/_auth.http', 'Shop API/_variables.json', 'Shop API/pre-request.js',
  ].sort());
});

test('importPostman: URL, header & query nonaktif -> # @disabled, deskripsi komentar', () => {
  const r = parseRequest(file(plan(), 'Shop API/Users/List users.http')!.content);
  assert.equal(r.title, 'List users');
  assert.equal(r.url, '{{baseUrl}}/users?page=1');
  assert.deepEqual(r.headers.map((h) => [h.name, h.enabled]), [['X-Id', true], ['X-Off', false]]);
  assert.deepEqual(r.disabledParams, [{ key: 'debug', value: '1' }]);
  assert.ok(r.preamble.includes('# All users'));
});

test('importPostman: path variable :id -> {{id}}; noauth -> # @auth none; body json + Content-Type', () => {
  const r = parseRequest(file(plan(), 'Shop API/Users/Create user.http')!.content);
  assert.equal(r.url, 'https://api.shop.test/users/{{id}}');
  assert.equal(r.auth, 'none');
  assert.equal(r.body, '{"name":"a"}');
  assert.equal(r.headers.find((h) => h.name === 'Content-Type')?.value, 'application/json');
});

test('importPostman: urlencoded (nonaktif dilewati, {{var}} utuh), multipart, binary, GraphQL', () => {
  const p = plan();
  const form = parseRequest(file(p, 'Shop API/Login form.http')!.content);
  assert.equal(form.body, 'user=a%20b&pw={{pw}}');
  assert.equal(form.headers.find((h) => h.name === 'Content-Type')?.value, 'application/x-www-form-urlencoded');
  const up = file(p, 'Shop API/Upload.http')!.content;
  assert.match(up, /Content-Type: multipart\/form-data; boundary=/);
  assert.match(up, /Content-Disposition: form-data; name="title"\n\nhi/);
  assert.match(up, /Content-Disposition: form-data; name="file"; filename="a\.png"\n\n< \.\/a\.png/);
  const raw = parseRequest(file(p, 'Shop API/Raw file.http')!.content);
  assert.equal(raw.bodyFile, './x.bin');
  const gql = file(p, 'Shop API/GQL.http')!;
  assert.deepEqual(JSON.parse(parseRequest(gql.content).body), { query: '{ me { id } }', variables: { a: 1 } });
  assert.ok(gql.warnings.some((w) => /GraphQL/.test(w)));
});

test('importPostman: auth collection/folder -> _auth.http, request auth tidak dobel', () => {
  const p = plan();
  assert.equal(parseRequest(file(p, 'Shop API/_auth.http')!.content).auth, 'bearer token={{tok}}');
  assert.equal(parseRequest(file(p, 'Shop API/Users/_auth.http')!.content).auth, 'basic username=u password="p w"');
  assert.equal(parseRequest(file(p, 'Shop API/Users/List users.http')!.content).auth, undefined);
});

test('importPostman: semua jenis auth', () => {
  const one = (auth: unknown) => parseRequest(file(importPostman({ info: { name: 'A', schema: SCHEMA }, item: [{ name: 'r', request: { method: 'GET', url: 'https://a.test', auth } }] }), 'A/r.http')!.content).auth;
  assert.equal(one({ type: 'apikey', apikey: [{ key: 'key', value: 'X-K' }, { key: 'value', value: 'v' }, { key: 'in', value: 'header' }] }), 'apiKey key=X-K value=v in=header');
  assert.equal(one({ type: 'digest', digest: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }, { key: 'realm', value: 'r' }] }), 'digest username=u password=p realm=r');
  assert.equal(one({ type: 'awsv4', awsv4: [{ key: 'accessKey', value: 'a' }, { key: 'secretKey', value: 's' }, { key: 'region', value: 'eu' }, { key: 'service', value: 'x' }] }), 'aws access_key=a secret_key=s region=eu service=x');
  assert.equal(one({ type: 'hawk', hawk: [{ key: 'authId', value: 'i' }, { key: 'authKey', value: 'k' }] }), 'hawk id=i key=k');
  assert.equal(one({ type: 'oauth1', oauth1: [{ key: 'consumerKey', value: 'ck' }, { key: 'consumerSecret', value: 'cs' }] }), 'oauth1 consumer_key=ck consumer_secret=cs');
  assert.equal(one({ type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'accessTokenUrl', value: 'https://a/t' }, { key: 'clientId', value: 'c' }, { key: 'clientSecret', value: 's' }, { key: 'scope', value: 'a b' }] }),
    'oauth2 grant=client_credentials token_url=https://a/t client_id=c client_secret=s scope="a b"');
  assert.equal(one({ type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'password_credentials' }] }), 'oauth2 grant=password');
  assert.equal(one({ type: 'bearer', bearer: [{ key: 'token', value: '' }] }), 'bearer token={{token}}', 'nilai kosong = placeholder variable');
  assert.equal(one({ type: 'jwt', jwt: [{ key: 'algorithm', value: 'HS256' }, { key: 'secret', value: 's' }] }), 'jwt algorithm=HS256 secret=s');
});

test('importPostman: auth tidak didukung (ntlm) -> peringatan, tanpa baris auth', () => {
  const p = importPostman({ info: { name: 'A', schema: SCHEMA }, item: [{ name: 'r', request: { method: 'GET', url: 'https://a.test', auth: { type: 'ntlm', ntlm: [] } } }] });
  assert.equal(parseRequest(file(p, 'A/r.http')!.content).auth, undefined);
  assert.ok(file(p, 'A/r.http')!.warnings.some((w) => /ntlm/.test(w)));
});

test('importPostman: variable collection -> _variables.json (tanpa secret); script -> .js terjemahan', () => {
  const p = plan();
  assert.deepEqual(parseEnvironment(file(p, 'Shop API/_variables.json')!.content), [{ key: 'baseUrl', value: 'https://api.shop.test' }, { key: 'tok', value: 'abc' }]);
  assert.match(file(p, 'Shop API/pre-request.js')!.content, /httpme\.environment\.set\("t", 1\)/);
  assert.match(file(p, 'Shop API/Users/List users.post-request.js')!.content, /httpme\.expect\.equal\(httpme\.response\.status, 200\)/);
});

test('importPostman: method tidak didukung dilewati + peringatan; nama kembar diberi nomor', () => {
  const p = plan();
  assert.ok(!p.files.some((f) => /Odd/.test(f.path)));
  assert.ok(p.warnings.some((w) => /PROPFIND/.test(w)));
  const d = importPostman({ info: { name: 'A', schema: SCHEMA }, item: [{ name: 'x', request: { method: 'GET', url: 'https://a/1' } }, { name: 'X', request: { method: 'GET', url: 'https://a/2' } }] });
  assert.deepEqual(d.files.map((f) => f.path), ['A/x.http', 'A/X 2.http']);
});

test('importPostman: Collection v1 / bukan collection ditolak', () => {
  assert.throws(() => importPostman({ id: 'x', name: 'o', order: [], requests: [] }), /Re-export as Collection v2\.1/);
  assert.throws(() => importPostman({ foo: 1 }), /not a Postman collection/);
});

test('importPostman: variable dinamis tak dikenal -> peringatan', () => {
  const p = importPostman({ info: { name: 'A', schema: SCHEMA }, item: [{ name: 'r', request: { method: 'GET', url: 'https://a/{{$randomFirstName}}/{{$guid}}' } }] });
  assert.ok(file(p, 'A/r.http')!.warnings.some((w) => /\$randomFirstName/.test(w)));
  assert.ok(!file(p, 'A/r.http')!.warnings.some((w) => /\$guid/.test(w)));
});
