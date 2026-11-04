import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { importCurl, parseCurl, tokenize, toCurl } from '../../src/curl';
import { parseRequest } from '../../src/httpFile';

test('tokenize: kutip tunggal, ganda (escape), $\'…\' ANSI-C, backslash, sambungan baris', () => {
  assert.deepEqual(tokenize(`curl 'a b' "c \\"d\\" \\$e" $'x\\ny\\'z\\x41' f\\ g \\\n  -k`), ['curl', 'a b', 'c "d" $e', "x\ny'zA", 'f g', '-k']);
  assert.deepEqual(tokenize(`curl -H 'it'"'"'s'`), ['curl', '-H', "it's"]);
  assert.throws(() => tokenize(`curl 'open`), /Unclosed quote/);
});

test('parseCurl: method, URL, header, body; -d tanpa -X = POST form', () => {
  const r = parseCurl(`curl 'https://api.test/log?x=1' -H 'Content-Type: application/json' -H 'X-Id: 7' --data-raw '{"a":1}'`);
  assert.deepEqual([r.request.method, r.request.url, r.request.body, r.request.bodyType], ['POST', 'https://api.test/log?x=1', '{"a":1}', 'json']);
  assert.deepEqual(r.request.headers.map((h) => `${h.name}: ${h.value}`), ['Content-Type: application/json', 'X-Id: 7']);
  assert.deepEqual(r.warnings, []);
  const form = parseCurl(`curl -d a=1 -d b=2 https://a.test`);
  assert.deepEqual([form.request.method, form.request.body], ['POST', 'a=1&b=2']);
  assert.ok(form.request.headers.some((h) => h.name === 'Content-Type' && h.value === 'application/x-www-form-urlencoded'));
  assert.equal(parseCurl(`curl -X PUT --url https://a.test/1 --data-binary @file`).request.method, 'PUT');
});

test('parseCurl: -u, -b, -L, -k, -G, -I, --json, -A, -e, --data-urlencode', () => {
  const r = parseCurl(`curl -u user:pa:ss -b 'sid=1; t=2' -k -A 'agent/1' -e https://ref.test https://a.test`);
  assert.ok(r.request.headers.some((h) => h.name === 'Authorization' && h.value === 'Basic user:pa:ss'));
  assert.ok(r.request.headers.some((h) => h.name === 'Cookie' && h.value === 'sid=1; t=2'));
  assert.ok(r.request.headers.some((h) => h.name === 'User-Agent' && h.value === 'agent/1'));
  assert.ok(r.request.headers.some((h) => h.name === 'Referer' && h.value === 'https://ref.test'));
  assert.equal(r.request.insecure, true);
  assert.equal(r.request.followRedirects, false, 'tanpa -L curl tidak mengikuti redirect');
  assert.equal(parseCurl('curl -L https://a').request.followRedirects, true);
  const g = parseCurl(`curl -G -d q=a -d page=2 https://a.test/s`);
  assert.deepEqual([g.request.method, g.request.url, g.request.body], ['GET', 'https://a.test/s?q=a&page=2', '']);
  assert.equal(parseCurl('curl -I https://a').request.method, 'HEAD');
  const j = parseCurl(`curl --json '{"x":1}' https://a`);
  assert.deepEqual([j.request.method, j.request.body, j.request.bodyType], ['POST', '{"x":1}', 'json']);
  assert.equal(parseCurl(`curl --data-urlencode 'q=a b&c' https://a`).request.body, 'q=a%20b%26c');
});

test('parseCurl: opsi tak dikenal & yang tidak diimpor dilaporkan; bukan perintah curl = error', () => {
  const r = parseCurl(`curl --compressed -s --http2 -F f=@a.png --weird https://a`);
  assert.deepEqual(r.warnings, ['Ignored option --http2', 'Multipart (-F f=@a.png) is not imported yet', 'Unknown option --weird']);
  assert.throws(() => parseCurl('wget https://a'), /Not a curl command/);
  assert.throws(() => parseCurl('curl -H x'), /No URL/);
});

test('toCurl: perintah bash multi-baris dengan kutip aman; dibaca balik sama', () => {
  const req = parseRequest(`POST https://api.test/x?y=1\nContent-Type: application/json\n# @disabled X-Off: 1\n\n{"it's":1}\n`);
  req.insecure = true;
  const cmd = toCurl(req);
  assert.equal(cmd, `curl -X POST 'https://api.test/x?y=1' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{"it'\\''s":1}' \\\n  -L \\\n  -k`);
  const back = parseCurl(cmd).request;
  assert.deepEqual([back.method, back.url, back.body, back.insecure, back.followRedirects], ['POST', 'https://api.test/x?y=1', `{"it's":1}`, true, true]);
  assert.equal(toCurl(parseRequest('GET https://a\n')), `curl 'https://a' \\\n  -L`);
});

// contoh "Copy as cURL (bash)" Chrome, data disamarkan
const CHROME = `curl 'https://shop.example.com/pos/log/post' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'accept-language: en-US,en;q=0.9,id;q=0.8' \\
  -H 'authorization: Bearer eyJhbGciOi.REDACTED.sig' \\
  -H 'content-type: application/json' \\
  -b 'JSESSIONID=ABC123; theme=dark' \\
  -H 'origin: https://shop.example.com' \\
  -H 'priority: u=1, i' \\
  -H 'referer: https://shop.example.com/dashboard' \\
  -H 'sec-ch-ua: "Chromium";v="142", "Not_A Brand";v="99"' \\
  -H 'sec-ch-ua-mobile: ?0' \\
  -H 'sec-ch-ua-platform: "Windows"' \\
  -H 'sec-fetch-dest: empty' \\
  -H 'sec-fetch-mode: cors' \\
  -H 'sec-fetch-site: same-origin' \\
  -H 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)' \\
  --data-raw '{"method":"Activity History","pathUrl":"dashboard"}'`;

test('importCurl: contoh Copy as cURL Chrome -> request lengkap, header browser dimatikan, ringkasan untuk notifikasi', () => {
  const { request, summary } = importCurl(CHROME);
  assert.deepEqual([request.method, request.url, request.bodyType], ['POST', 'https://shop.example.com/pos/log/post', 'json']);
  assert.equal(request.body, '{"method":"Activity History","pathUrl":"dashboard"}');
  const on = request.headers.filter((h) => h.enabled).map((h) => h.name.toLowerCase());
  const off = request.headers.filter((h) => !h.enabled).map((h) => h.name.toLowerCase());
  assert.deepEqual(on, ['accept', 'authorization', 'content-type', 'cookie']);
  assert.deepEqual(off.sort(), ['accept-language', 'origin', 'priority', 'referer', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'user-agent']);
  assert.equal(summary, 'Imported POST /pos/log/post: 11 browser headers disabled.');
  assert.equal(request.followRedirects, true, 'Copy as cURL browser tidak pernah memakai -L, padahal browser mengikuti redirect');
  assert.equal(importCurl(`curl --http2 https://a/x`).summary, 'Imported GET /x. Ignored option --http2');
});

test('toCurl: header Cookie tidak ikut kecuali dicentang (withCookies); cookie jar digabung; importCookies dari Cookie: / -b', () => {
  const req = parseRequest('GET https://a.test/x\nCookie: sid=1\nX-A: 1\n');
  assert.equal(toCurl(req), `curl 'https://a.test/x' \\\n  -H 'X-A: 1' \\\n  -L`);
  assert.equal(toCurl(req, { withCookies: true, jar: 'theme=dark; sid=9' }), `curl 'https://a.test/x' \\\n  -H 'X-A: 1' \\\n  -b 'sid=1; theme=dark' \\\n  -L`);
  assert.equal(toCurl(parseRequest('GET https://a\n'), { withCookies: true, jar: 'k=v' }), `curl 'https://a' \\\n  -b 'k=v' \\\n  -L`);
  assert.equal(importCurl(`curl https://a -b 'sid=1; t=2'`).cookies, 'sid=1; t=2');
  assert.equal(importCurl(`curl https://a -H 'Cookie: a=b'`).cookies, 'a=b');
  assert.equal(importCurl(`curl https://a`).cookies, undefined);
});
