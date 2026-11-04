import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { SNIPPETS } from '../../src/scriptSnippets';

test('snippets: 5 Before request + 5 After response, judul sesuai, isi JS valid', () => {
  assert.deepEqual(SNIPPETS.pre.map((s) => s.title), ['Set a request header', 'Set an Environment variable', 'Get an Environment variable', 'Skip this request', 'HMAC signature header']);
  assert.deepEqual(SNIPPETS.post.map((s) => s.title), ['Status code is 200', 'Response time below 500 ms', 'Save a JSON value to the Environment', 'Body contains a string', 'Log the response']);
  for (const s of [...SNIPPETS.pre, ...SNIPPETS.post]) {
    assert.doesNotThrow(() => new Script(`(async () => {${s.code}\n})`), s.title);
    assert.ok(s.code.endsWith('\n'), s.title);
  }
});
