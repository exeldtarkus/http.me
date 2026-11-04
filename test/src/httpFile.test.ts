import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { emptyRequest, parseRequest, serializeRequest, toHttpRequest, type ParsedRequest } from '../../src/httpFile';

test('parseRequest: baris request, header, body; baris lain di atas disimpan apa adanya', () => {
  const r = parseRequest('### Log page view\n# @name logPageView\n\nPOST https://api.test/log?a=1 HTTP/1.1\nContent-Type: application/json\nX-Id: 7\n\n{"a":1}\n');
  assert.deepEqual([r.title, r.name, r.preamble], ['Log page view', 'logPageView', []]);
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://api.test/log?a=1');
  assert.deepEqual(r.headers, [
    { name: 'Content-Type', value: 'application/json', enabled: true },
    { name: 'X-Id', value: '7', enabled: true },
  ]);
  assert.equal(r.body, '{"a":1}');
  assert.equal(r.bodyType, 'json');
});

test('parseRequest: URL saja = GET, file kosong = GET kosong, method huruf kecil dinormalkan', () => {
  assert.equal(parseRequest('https://a.test/x\n').method, 'GET');
  assert.equal(parseRequest('https://a.test/x\n').url, 'https://a.test/x');
  assert.deepEqual(parseRequest(''), emptyRequest());
  assert.equal(parseRequest('query https://a.test\n').method, 'QUERY');
});

test('metadata: # @disabled header / param, # @no-redirect, # @insecure, # @timeout', () => {
  const r = parseRequest('# @no-redirect\n# @insecure\n# @timeout 5\n# @disabled Sec-Fetch-Mode: cors\n# @disabled debug=true\nGET https://a.test/?x=1\nAccept: */*\n');
  assert.equal(r.followRedirects, false);
  assert.equal(r.insecure, true);
  assert.equal(r.timeoutSec, 5);
  assert.deepEqual(r.headers, [{ name: 'Accept', value: '*/*', enabled: true }, { name: 'Sec-Fetch-Mode', value: 'cors', enabled: false }]);
  assert.deepEqual(r.disabledParams, [{ key: 'debug', value: 'true' }]);
  assert.deepEqual(r.preamble, []);
});

test('bodyType dari Content-Type', () => {
  const t = (ct: string, body = 'x') => parseRequest(`POST https://a\nContent-Type: ${ct}\n\n${body}\n`).bodyType;
  assert.equal(t('application/json; charset=utf-8'), 'json');
  assert.equal(t('application/problem+json'), 'json');
  assert.equal(t('text/xml'), 'xml');
  assert.equal(t('application/soap+xml'), 'xml');
  assert.equal(t('application/x-www-form-urlencoded'), 'form');
  assert.equal(t('text/plain'), 'text');
  assert.equal(parseRequest('POST https://a\n\nraw\n').bodyType, 'text');
  assert.equal(parseRequest('POST https://a\nContent-Type: application/json\n').bodyType, 'none');
});

test('serializeRequest: urutan rapi (preamble, metadata, request, header, body) dan round-trip', () => {
  const r: ParsedRequest = {
    ...emptyRequest(), title: 'Title', method: 'POST', url: 'https://a.test/p?x=1',
    headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }, { name: 'X-Off', value: '1', enabled: false }],
    disabledParams: [{ key: 'debug', value: 'true' }], body: '{\n  "a": 1\n}', bodyType: 'json',
    followRedirects: false, insecure: true, timeoutSec: 10,
  };
  const text = serializeRequest(r);
  assert.equal(text, '### Title\n# @no-redirect\n# @insecure\n# @timeout 10\n# @disabled X-Off: 1\n# @disabled debug=true\nPOST https://a.test/p?x=1\nContent-Type: application/json\n\n{\n  "a": 1\n}\n');
  assert.deepEqual(parseRequest(text), r);
  assert.equal(serializeRequest(parseRequest('GET https://a.test\n')), 'GET https://a.test\n');
  assert.equal(serializeRequest(parseRequest('GET https://a.test\nAccept: a\n')), 'GET https://a.test\nAccept: a\n');
});

test('toHttpRequest: hanya header aktif, body tidak dikirim bila kosong', () => {
  const r = parseRequest('# @disabled X-Off: 1\nPOST https://a.test\nContent-Type: text/plain\n\nhi\n');
  assert.deepEqual(toHttpRequest(r), { method: 'POST', url: 'https://a.test', headers: [['Content-Type', 'text/plain']], body: 'hi' });
  assert.deepEqual(toHttpRequest(parseRequest('GET https://a.test\nX-A: 1\n')), { method: 'GET', url: 'https://a.test', headers: [['X-A', '1']], body: undefined });
});

test('### judul tampil, # @name ID (juga // @name), komentar # dan // dipertahankan', () => {
  const r = parseRequest('### Log page view\n# @name logPageView\n# catatan tim\n// lihat tiket 12\nGET https://a.test\n');
  assert.equal(r.title, 'Log page view');
  assert.equal(r.name, 'logPageView');
  assert.deepEqual(r.preamble, ['# catatan tim', '// lihat tiket 12']);
  assert.equal(parseRequest('// @name x\nGET https://a\n').name, 'x');
  assert.equal(parseRequest('###\nGET https://a\n').title, '');
  assert.equal(parseRequest('GET https://a\n').title, undefined);
});

test('round-trip: parse → serialize → parse sama untuk file tulisan tangan; isi tidak hilang', () => {
  const samples = [
    'GET https://a.test\n',
    '### T\n# @name t\nPOST https://a.test/p HTTP/1.1\nContent-Type: application/json\n\n{"a":1}\n',
    '# komentar\n\n\nGET https://a.test?x=1\nAccept: */*\n\n',
    '###   Spasi judul  \r\n// @name w\r\nDELETE https://a.test/1\r\n',
  ];
  for (const s of samples) {
    const once = parseRequest(s);
    const text = serializeRequest(once);
    assert.deepEqual(parseRequest(text), once, s);
    assert.equal(serializeRequest(parseRequest(text)), text, 'serialize stabil');
  }
  assert.equal(serializeRequest(parseRequest('### T\n# @name t\n# c\nGET https://a\n')), '### T\n# @name t\n# c\nGET https://a\n');
});
