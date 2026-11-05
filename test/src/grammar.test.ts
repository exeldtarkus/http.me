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
    embeddedLanguages: { 'meta.embedded.block.json': 'json', 'meta.embedded.block.xml': 'xml', 'meta.embedded.block.javascript': 'javascript' } }]);
  assert.equal(g.scopeName, 'source.http');
  assert.deepEqual(g.patterns.map((p) => p.include), ['#separator', '#comment', '#script-inline', '#script-file', '#file-variable', '#request-line', '#json-body', '#xml-body', '#header', '#variable']);
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
