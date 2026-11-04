import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseCurl, tokenize, toCurl } from '../../src/curl';
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
