import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { varize, varizeCandidates } from '../../src/varize';
import { emptyRequest, type ParsedRequest } from '../../src/httpFile';

const envs = [
  { name: 'dev', values: new Map([['BASE_URL', 'https://shop.example.com'], ['BASE_URL_WORKER', 'https://shop.example.com/worker'], ['TOKEN', 'eyJhbGciOi.dev.sig']]) },
  { name: 'uat', values: new Map([['BASE_URL', 'https://uat.example.com'], ['USER_ID', '12345'], ['SAME', 'https://shop.example.com/worker'], ['CODE', 'abc']]) },
];
const globals = new Map([['SESSION', 'ABC123XYZ'], ['G_TOKEN', 'eyJhbGciOi.dev.sig']]);

function req(o: Partial<ParsedRequest>): ParsedRequest {
  return { ...emptyRequest(), ...o };
}

test('varizeCandidates: Environment aktif → lain → Globals, terpanjang dulu; nilai < 4 karakter / sudah {{ / NULL / ganda dibuang', () => {
  const c = varizeCandidates('uat', [...envs, { name: 'x', values: new Map([['N', null], ['V', '{{a}}xxxx']]) }], globals);
  assert.deepEqual(c.map((x) => `${x.name}@${x.env ?? 'Globals'}`), [
    'SAME@uat', 'BASE_URL@uat', 'USER_ID@uat',
    'BASE_URL@dev', 'TOKEN@dev',
    'SESSION@Globals',
  ]);
});

test('URL: prefix terpanjang di batas / ? # (BASE_URL_WORKER, bukan BASE_URL); batas .idx tidak dipotong', () => {
  const c = varizeCandidates('dev', envs, globals);
  assert.equal(varize(req({ url: 'https://shop.example.com/worker/pos/log?x=1' }), c).request.url, '{{BASE_URL_WORKER}}/pos/log?x=1');
  assert.equal(varize(req({ url: 'https://shop.example.com/workers/x' }), c).request.url, '{{BASE_URL}}/workers/x');
  assert.equal(varize(req({ url: 'https://shop.example.com.idx/x' }), c).request.url, 'https://shop.example.com.idx/x');
  assert.equal(varize(req({ url: 'https://shop.example.com' }), c).request.url, '{{BASE_URL}}');
  assert.equal(varize(req({ url: 'https://shop.example.com#top' }), c).request.url, '{{BASE_URL}}#top');
});

test('query param, header, Bearer, cookie, body JSON rekursif, form: nilai persis; Environment lain dilaporkan', () => {
  const c = varizeCandidates('dev', envs, globals);
  const out = varize(req({
    url: 'https://shop.example.com/u?id=12345&q=12345x&c=abc',
    headers: [
      { name: 'Authorization', value: 'Bearer eyJhbGciOi.dev.sig', enabled: true },
      { name: 'Cookie', value: 'theme=dark; sid=ABC123XYZ', enabled: true },
      { name: 'X-User', value: '12345', enabled: true },
    ],
    body: '{\n  "user": { "id": "12345", "tags": ["ABC123XYZ", 12345] },\n  "12345": 1\n}',
    bodyType: 'json',
  }), c);
  assert.equal(out.request.url, '{{BASE_URL}}/u?id={{USER_ID}}&q=12345x&c=abc', 'abc < 4 karakter diabaikan');
  assert.deepEqual(out.request.headers.map((h) => h.value), ['Bearer {{TOKEN}}', 'theme=dark; sid={{SESSION}}', '{{USER_ID}}']);
  assert.equal(out.request.body, '{\n  "user": { "id": "{{USER_ID}}", "tags": ["{{SESSION}}", 12345] },\n  "12345": 1\n}', 'key JSON & angka tidak diganti');
  assert.deepEqual(out.replaced.map((r) => `${r.name}@${r.env ?? 'Globals'}`), ['BASE_URL@dev', 'USER_ID@uat', 'TOKEN@dev', 'SESSION@Globals']);
  const form = varize(req({ body: 'user=12345&n=ABC123XYZ&x=1', bodyType: 'form' }), c);
  assert.equal(form.request.body, 'user={{USER_ID}}&n={{SESSION}}&x=1');
});

test('nilai ganda: Environment aktif menang; secret tetap diganti; yang sudah {{ dibiarkan', () => {
  const c = varizeCandidates('uat', envs, globals);
  assert.equal(varize(req({ url: 'https://shop.example.com/worker/x' }), c).request.url, '{{SAME}}/x');
  const secretOnly = varizeCandidates(undefined, [{ name: 'dev', values: new Map([['PW', 's3cret-pass']]) }], new Map());
  assert.deepEqual(varize(req({ url: 'https://a/x', headers: [{ name: 'X-Pw', value: 's3cret-pass', enabled: true }] }), secretOnly).request.headers[0].value, '{{PW}}');
  assert.equal(varize(req({ url: '{{BASE_URL}}/x?id=12345' }), c).request.url, '{{BASE_URL}}/x?id={{USER_ID}}');
  assert.deepEqual(varize(req({ url: 'https://none/x' }), c).replaced, []);
});
