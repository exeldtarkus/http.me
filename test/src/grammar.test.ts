import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
type Rule = { match?: string; begin?: string; end?: string; name?: string; captures?: Record<string, { name: string }>; patterns?: Rule[]; include?: string; contentName?: string };
const g = JSON.parse(readFileSync(join(root, 'syntaxes', 'http.tmLanguage.json'), 'utf8')) as { scopeName: string; patterns: Rule[]; repository: Record<string, Rule> };
// regex grammar sederhana: cukup dicoba dengan RegExp JS (tanpa fitur khusus Oniguruma)
const re = (name: string, key: 'match' | 'begin' | 'end' = 'match') => new RegExp(g.repository[name][key]!);

test('review R39: grammar .http terdaftar untuk bahasa http, body JSON / XML memakai grammar bawaan', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.contributes.grammars, [{ language: 'http', scopeName: 'source.http', path: './syntaxes/http.tmLanguage.json',
    embeddedLanguages: { 'meta.embedded.block.json': 'json', 'meta.embedded.block.xml': 'xml', 'meta.embedded.block.javascript': 'javascript' } },
  { scopeName: 'source.http.variables', path: './syntaxes/http.variables.tmLanguage.json', injectTo: ['source.http'] }]);
  assert.equal(g.scopeName, 'source.http');
  assert.deepEqual(g.patterns.map((p) => p.include), ['#separator', '#comment', '#script-inline', '#script-file', '#file-variable', '#curl-command', '#request-line', '#json-body', '#xml-body', '#header', '#variable']);
  assert.ok(g.repository['json-body'].patterns!.some((p) => p.include === 'source.json'));
  assert.ok(g.repository['xml-body'].patterns!.some((p) => p.include === 'text.xml'));
});

test('review R39: grammar .http: request line, header, komentar + direktif, pemisah, variabel', () => {
  assert.deepEqual(re('request-line').exec('POST {{HOST}}/api/v1/reports HTTP/1.1')!.slice(1, 4), ['POST', '{{HOST}}/api/v1/reports', 'HTTP/1.1']);
  assert.equal(re('request-line').exec('GET https://a.test')![1], 'GET');
  assert.equal(re('request-line').exec('  "format": "PDF",'), null);
  assert.deepEqual(re('header').exec('Content-Type: application/json')!.slice(1, 4), ['Content-Type', ':', 'application/json']);
  assert.equal(re('header').exec('  "a": 1'), null, 'baris JSON bukan header');
  assert.ok(re('comment', 'begin').test('# @disabled Accept-Encoding: gzip'));
  assert.ok(re('comment', 'begin').test('// catatan'));
  assert.equal(new RegExp(g.repository.comment.patterns![0].match!).exec('# @disabled Accept')![0], '@disabled');
  assert.ok(re('separator').test('### Login'));
  assert.equal(re('variable').exec('x {{REPORT_SERVICE_HOST}}/y')![0], '{{REPORT_SERVICE_HOST}}');
  assert.ok(re('json-body', 'begin').test('{'));
  assert.ok(re('xml-body', 'begin').test('<order>'));
});

test('review R49: grammar .http: baris script < / > bukan body XML, body berhenti di script, URL berspasi, variabel file', () => {
  assert.deepEqual(re('script-file').exec('< ./scripts/new-booking-body.js')!.slice(1, 3), ['<', './scripts/new-booking-body.js']);
  assert.deepEqual(re('script-file').exec('> ./scripts/save-booking-id.js')!.slice(1, 3), ['>', './scripts/save-booking-id.js']);
  assert.equal(re('script-file').exec('< {% httpme.skip(); %}'), null, 'script inline punya pola sendiri');
  assert.ok(re('script-inline', 'begin').test('< {% httpme.skip(); %}'));
  assert.ok(re('script-inline', 'begin').test('> {%'));
  assert.equal(re('xml-body', 'begin').test('< ./scripts/sign-request.js'), false, 'script bukan body XML');
  assert.ok(re('xml-body', 'begin').test('<?xml version="1.0"?>'));
  for (const body of ['json-body', 'xml-body']) {
    const end = re(body, 'end');
    assert.ok(end.test('> {%'), body);
    assert.ok(end.test('> ./scripts/save.js'), body);
    assert.ok(end.test('### Next'), body);
    assert.equal(end.test('  "a": 1'), false, body);
  }
  assert.deepEqual(re('request-line').exec('GET {{HTTPBIN_URL}}/cookies/set?session=demo-{{$randomInt 1 999}}')!.slice(1, 3), ['GET', '{{HTTPBIN_URL}}/cookies/set?session=demo-{{$randomInt 1 999}}']);
  assert.deepEqual(re('file-variable').exec('@host = https://a.test')!.slice(1, 5), ['@', 'host', '=', 'https://a.test']);
});

test('review R50: {{variabel}} berwarna sendiri: kurung, variabel Environment, variabel dinamis + argumen; juga di dalam string body', () => {
  const v = g.repository.variable;
  const m = new RegExp(v.match!).exec('a {{$randomInt 1 999}} b')!;
  assert.equal(m[0], '{{$randomInt 1 999}}');
  assert.deepEqual([m[1], m[2], m[3].trim(), m[5]], ['{{', '$randomInt', '1 999', '}}']);
  const e = new RegExp(v.match!).exec('{{ JSONPLACEHOLDER_URL }}/posts')!;
  assert.deepEqual([e[1], e[4], e[5]], ['{{', 'JSONPLACEHOLDER_URL', '}}']);
  assert.equal(v.captures!['2'].name, 'support.function.dynamic.http');
  assert.equal(v.captures!['4'].name, 'variable.other.constant.http');
  assert.equal(v.captures!['1'].name, 'punctuation.definition.template-expression.begin.http');
  const inj = JSON.parse(readFileSync(join(root, 'syntaxes', 'http.variables.tmLanguage.json'), 'utf8'));
  assert.equal(inj.injectionSelector, 'L:meta.embedded.block.json, L:meta.embedded.block.xml');
  assert.deepEqual(inj.patterns, [{ include: 'source.http#variable' }]);
});

test('grammar .http: perintah curl berwarna (perintah, opsi, string, URL) sampai baris tanpa \\ di ujung', () => {
  const b = re('curl-command', 'begin');
  const e = re('curl-command', 'end');
  assert.equal(b.exec("curl --request POST \\")![1], 'curl');
  assert.equal(b.exec('curl.exe -X GET https://a.test')![1], 'curl.exe');
  assert.equal(b.test('curling'), false);
  assert.equal(b.test('Curl-Header: x'), false);
  assert.equal(e.test("  --url http://x \\\n"), false, 'sambungan baris: lanjut');
  assert.ok(e.test("  --data '{}'\n"), 'tanpa \\: perintah selesai');
  const opt = new RegExp(g.repository['curl-command'].patterns!.find((x) => x.match?.startsWith('(?<=\\s)--?'))!.match!);
  assert.equal(opt.exec(' --header')![0], '--header');
  assert.equal(opt.exec(' -X')![0], '-X');
});

test('grammar .http: curl --header (nama + nilai), --data (JSON), --url punya scope sendiri', () => {
  const ps = g.repository['curl-command'].patterns!;
  const h = new RegExp(ps[0].begin!);
  assert.deepEqual(h.exec("  --header 'Accept: */*' \\")!.slice(1, 4), ['--header', ' ', "'"]);
  assert.equal(h.exec('  -H "X-A: 1"')![1], '-H');
  assert.equal(new RegExp(ps[0].patterns![0].match!.replace('\\G', '')).exec('Accept: */*')![1], 'Accept');
  const dta = new RegExp(ps[1].begin!);
  assert.equal(dta.exec(`  --data '{"a":1}'`)![1], '--data');
  assert.equal(new RegExp(ps[2].begin!).exec('  --data-raw "x"')![1], '--data-raw');
  assert.equal(dta.exec('  -d \'x\'')![1], '-d');
  assert.ok(ps[1].patterns!.some((x) => x.include === 'source.json'));
  assert.equal(new RegExp(ps[3].match!).exec('  --url http://localhost:8081/x \\')![3], 'http://localhost:8081/x');
});
