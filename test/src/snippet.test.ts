import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { generateSnippet, maskSecrets, usesSecrets, type SnippetOptions } from '../../src/snippet';
import { parseRequest } from '../../src/httpFile';

const base: SnippetOptions = { language: 'curl', longForm: false, resolve: true, followRedirects: true, cookies: false, disabledHeaders: false, multiLine: true };
const req = parseRequest('POST https://a.test/p?x=1\nContent-Type: application/json\nCookie: s=1\n# @disabled X-Off: 1\n\n{"a":1}\n');

test('generateSnippet curl: pendek / long-form, satu baris / multi-baris', () => {
  const short = generateSnippet(req, base);
  assert.equal(short, `curl -X POST 'https://a.test/p?x=1' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{"a":1}' \\\n  -L`);
  const long = generateSnippet(req, { ...base, longForm: true, multiLine: false });
  assert.equal(long, `curl --request POST 'https://a.test/p?x=1' --header 'Content-Type: application/json' --data-raw '{"a":1}' --location`);
});

test('generateSnippet: follow redirects, cookies, disabled headers per bahasa', () => {
  for (const language of ['curl', 'cmd', 'powershell'] as const) {
    const o = { ...base, language };
    assert.doesNotMatch(generateSnippet(req, o), /X-Off|Cookie|s=1/, `${language}: default tanpa disabled & cookie`);
    assert.match(generateSnippet(req, { ...o, disabledHeaders: true }), /X-Off/, language);
    const withJar = generateSnippet(req, { ...o, cookies: true }, { jar: 'j=2' });
    assert.match(withJar, language === 'powershell' ? /Cookie\("s", "1".*Cookie\("j", "2"/s : /s=1; j=2/, language);
  }
  assert.doesNotMatch(generateSnippet(req, { ...base, followRedirects: false }), /-L/);
  assert.match(generateSnippet(req, { ...base, language: 'powershell', followRedirects: false }), /-MaximumRedirection 0/);
  assert.doesNotMatch(generateSnippet(req, { ...base, language: 'powershell' }), /-MaximumRedirection/);
});

test('generateSnippet: multi-line cmd ^ dan PowerShell `, satu baris tanpa sambungan', () => {
  assert.match(generateSnippet(req, { ...base, language: 'cmd' }), / \^\n/);
  assert.match(generateSnippet(req, { ...base, language: 'powershell' }), / `\n/);
  for (const language of ['curl', 'cmd', 'powershell'] as const) assert.doesNotMatch(generateSnippet(req, { ...base, language, multiLine: false }), /\n/, language);
  assert.match(generateSnippet(req, { ...base, language: 'powershell', multiLine: false }), /-Uri "https:\/\/a\.test\/p\?x=1" -Method "POST" -ContentType "application\/json" -Body/);
});

test('maskSecrets / usesSecrets: nilai secret diganti ********, terpanjang dulu, kosong diabaikan', () => {
  assert.equal(maskSecrets('Bearer abc123 abc', ['abc', 'abc123', '']), 'Bearer ******** ********');
  assert.equal(usesSecrets('x Bearer tok y', ['tok']), true);
  assert.equal(usesSecrets('x', ['tok', '']), false);
});
