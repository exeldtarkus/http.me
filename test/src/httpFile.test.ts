import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { emptyRequest, parseRequest, serializeRequest, toHttpRequest, toHttpRequestWithFile, splitBlocks, type ParsedRequest , cookieFlags , replaceBlock, blockLabel } from '../../src/httpFile';

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
  assert.equal(text, '### Title\n# @no-redirect\n# @timeout 10\n# @insecure\n# @disabled X-Off: 1\n# @disabled debug=true\nPOST https://a.test/p?x=1\nContent-Type: application/json\n\n{\n  "a": 1\n}\n');
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

test('metadata: tiap # @… dibaca ke field-nya dan ditulis balik dengan urutan rapi', () => {
  const text = [
    '### Login', '# @name login', '# @no-redirect', '# @no-cookie-jar', '# @timeout 5', '# @insecure', '# @login',
    '# @disabled X-Off: 1', '# @disabled debug=1', '# @operation getUser', '# @auth apikey key=X-Api-Key value={{apiKey}} in=header',
    '# @no-scripts', '# @no-pre', '# @no-post', 'POST https://a.test/login', '',
  ].join('\n');
  const r = parseRequest(text);
  assert.deepEqual(
    [r.followRedirects, r.noCookieJar, r.timeoutSec, r.insecure, r.login, r.operation, r.auth, r.noScripts, r.noPre, r.noPost],
    [false, true, 5, true, true, 'getUser', 'apikey key=X-Api-Key value={{apiKey}} in=header', true, true, true],
  );
  assert.deepEqual(r.preamble, []);
  assert.equal(serializeRequest(r), text);
  const plain = parseRequest('GET https://a\n');
  assert.deepEqual([plain.noCookieJar, plain.login, plain.operation, plain.auth, plain.noScripts, plain.noPre, plain.noPost], [false, false, undefined, undefined, false, false, false]);
});

test('metadata: urutan acak di file dibaca sama; @ tak dikenal tetap jadi komentar', () => {
  const r = parseRequest('// @no-post\n# @custom thing\n# @login\nGET https://a\n');
  assert.deepEqual([r.noPost, r.login], [true, true]);
  assert.deepEqual(r.preamble, ['# @custom thing']);
});

test('metadata auth: nilai dan komentar lain tetap round-trip; metadata kosong tidak hilang', () => {
  const text = '# catatan request\n# @auth bearer token={{accessToken}}\nGET https://a.test\nAuthorization: Bearer manual\n';
  const r = parseRequest(text);
  assert.equal(r.auth, 'bearer token={{accessToken}}');
  assert.deepEqual(r.preamble, ['# catatan request']);
  const serialized = '# @auth bearer token={{accessToken}}\n# catatan request\nGET https://a.test\nAuthorization: Bearer manual\n';
  assert.equal(serializeRequest(r), serialized);
  assert.deepEqual(parseRequest(serialized), r);

  const malformed = parseRequest('# @auth\nGET https://a.test\n');
  assert.equal(malformed.auth, '');
  assert.equal(serializeRequest(malformed), '# @auth\nGET https://a.test\n');
});

test('variabel file @var = value: dibaca berurutan, ditulis di atas file + baris kosong', () => {
  const r = parseRequest('@baseUrl = https://api.test\n@token=abc = def\n\n### T\nGET {{baseUrl}}/x\n');
  assert.deepEqual(r.vars, [{ name: 'baseUrl', value: 'https://api.test' }, { name: 'token', value: 'abc = def' }]);
  assert.equal(r.url, '{{baseUrl}}/x');
  assert.equal(serializeRequest(r), '@baseUrl = https://api.test\n@token = abc = def\n\n### T\nGET {{baseUrl}}/x\n');
  assert.deepEqual(parseRequest('GET https://a\n').vars, []);
  assert.deepEqual(parseRequest(serializeRequest(r)), r);
});

test('< / >: pre-script sebelum request, post-script setelah body, body dari file, script inline multi-baris', () => {
  const text = [
    '### Log', '< ./scripts/sign.js', '< {%', '  request.variables.set("t", 1);', '%}', 'POST {{baseUrl}}/log',
    'Content-Type: application/json', '', '{"a":1}', '', '> ./scripts/save-token.js', '> {% client.log("ok") %}', '',
  ].join('\n');
  const r = parseRequest(text);
  assert.deepEqual(r.preScripts, ['./scripts/sign.js', '{%\n  request.variables.set("t", 1);\n%}']);
  assert.deepEqual(r.postScripts, ['./scripts/save-token.js', '{% client.log("ok") %}']);
  assert.equal(r.body, '{"a":1}');
  assert.equal(r.bodyFile, undefined);
  assert.equal(serializeRequest(r), text);
  assert.deepEqual(parseRequest(serializeRequest(r)), r);
});

test('< ./body.json setelah header + baris kosong = body dari file (bukan script)', () => {
  const r = parseRequest('POST https://a\nContent-Type: application/json\n\n< ./body.json\n');
  assert.equal(r.bodyFile, './body.json');
  assert.equal(r.body, '');
  assert.deepEqual(r.preScripts, []);
  assert.equal(serializeRequest(r), 'POST https://a\nContent-Type: application/json\n\n< ./body.json\n');
  const multi = parseRequest('POST https://a\nContent-Type: multipart/form-data; boundary=B\n\n--B\nContent-Disposition: form-data; name="f"; filename="a.png"\n\n< ./a.png\n--B--\n');
  assert.equal(multi.bodyFile, undefined, 'multipart: < di dalam body tetap bagian body');
  assert.match(multi.body, /< \.\/a\.png/);
});

test('toHttpRequest: body dari file dibaca lewat fungsi baca yang diberikan', async () => {
  const r = parseRequest('POST https://a\nContent-Type: application/json\n\n< ./body.json\n');
  const req = await toHttpRequestWithFile(r, async (p) => { assert.equal(p, './body.json'); return Buffer.from('{"f":1}'); });
  assert.deepEqual(req.body, Buffer.from('{"f":1}'));
});

test('splitBlocks: dipecah per ###, variabel di atas file ikut ke tiap blok, blok tanpa request dilewati', () => {
  const text = '@base = https://a.test\n\n### One\nGET {{base}}/1\n\n### Two\n# @name two\nPOST {{base}}/2\n\n{"x":1}\n\n###\n# kosong\n';
  const blocks = splitBlocks(text);
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[2, 3], [5, 9]]);
  assert.equal(parseRequest(blocks[0].text).url, '{{base}}/1');
  assert.deepEqual(parseRequest(blocks[0].text).vars, [{ name: 'base', value: 'https://a.test' }]);
  assert.equal(parseRequest(blocks[1].text).name, 'two');
  assert.equal(parseRequest(blocks[1].text).body, '{"x":1}');
});

test('splitBlocks: request sebelum ### pertama = blok sendiri; file 1 request = 1 blok mulai baris request', () => {
  assert.deepEqual(splitBlocks('# c\nGET https://a/0\n###\nGET https://a/1\n').map((b) => [b.start, b.end, parseRequest(b.text).url]), [[0, 1, 'https://a/0'], [2, 3, 'https://a/1']]);
  assert.deepEqual(splitBlocks('GET https://a\n').map((b) => [b.start, b.end]), [[0, 0]]);
  assert.deepEqual(splitBlocks(''), []);
  assert.deepEqual(splitBlocks('# only comment\n'), []);
});

test('bug: komentar / metadata di tengah blok header bukan header', () => {
  const r = parseRequest('GET https://a\nAccept: */*\n# @disabled X-Off: 1\n// catatan\nX-On: 2\n');
  assert.deepEqual(r.headers, [{ name: 'Accept', value: '*/*', enabled: true }, { name: 'X-On', value: '2', enabled: true }, { name: 'X-Off', value: '1', enabled: false }]);
  assert.deepEqual(r.preamble, ['// catatan']);
});

test('metadata cookie: # @no-send-cookies / # @no-save-cookies (default kirim & simpan); @no-cookie-jar = keduanya mati', () => {
  const r = parseRequest('# @no-send-cookies\n# @no-save-cookies\nGET https://a\n');
  assert.deepEqual([r.noSendCookies, r.noSaveCookies], [true, true]);
  assert.equal(serializeRequest(r), '# @no-send-cookies\n# @no-save-cookies\nGET https://a\n');
  const plain = parseRequest('GET https://a\n');
  assert.deepEqual([plain.noSendCookies, plain.noSaveCookies], [false, false]);
  assert.deepEqual(cookieFlags(parseRequest('# @no-cookie-jar\nGET https://a\n')), { send: false, save: false });
  assert.deepEqual(cookieFlags(parseRequest('# @no-save-cookies\nGET https://a\n')), { send: true, save: false });
});

test('review R41: replaceBlock menulis ulang satu blok file multi-request; variabel kepala file & blok lain utuh', () => {
  const text = '@host = https://a.test\n\n### Satu\nGET {{host}}/1\n\n### Dua\n# @name kedua\nPOST {{host}}/2\nContent-Type: application/json\n\n{"a":1}\n\n### Tiga\nGET {{host}}/3\n';
  const blocks = splitBlocks(text);
  const r = parseRequest(blocks[1].text);
  assert.deepEqual(r.vars, [{ name: 'host', value: 'https://a.test' }], 'blok membawa variabel kepala file');
  r.url = '{{host}}/dua';
  r.body = '{"a":2}';
  assert.equal(replaceBlock(text, 1, r), text.replace('POST {{host}}/2', 'POST {{host}}/dua').replace('{"a":1}', '{"a":2}'));
  const t1 = parseRequest(blocks[0].text);
  t1.method = 'DELETE';
  assert.equal(replaceBlock(text, 0, t1), text.replace('GET {{host}}/1', 'DELETE {{host}}/1'));
  assert.equal(replaceBlock(text, 9, t1), text, 'indeks tidak ada = teks tetap');
});

test('review R41: blockLabel = judul ###, lalu # @name, lalu METHOD path', () => {
  const [a, b, c] = splitBlocks('### Login user\nPOST https://a.test/login\n\n###\n# @name ping\nGET https://a.test/ping\n\n###\nGET https://a.test/users?page=2\n');
  assert.equal(blockLabel(parseRequest(a.text)), 'Login user');
  assert.equal(blockLabel(parseRequest(b.text)), 'ping');
  assert.equal(blockLabel(parseRequest(c.text)), 'GET /users');
  assert.equal(blockLabel(parseRequest('GET {{host}}/x/y?z=1')), 'GET /x/y');
});
