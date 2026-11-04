import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorLine, maskSecrets } from '../../src/log';

const SRC = join(__dirname, '..', '..', '..', 'src');

test('errorLine: konteks + pesan + stack trace dalam satu baris log', () => {
  const e = new Error('boom');
  const line = errorLine('sendRequest', e);
  assert.match(line, /^sendRequest - EXCEPTION CAUGHT \| boom - stack-trace: Error: boom\n\s+at /);
  assert.equal(errorLine('x', 'plain'), 'x - EXCEPTION CAUGHT | plain - stack-trace: plain');
});

test('maskSecrets: Authorization, Cookie, Bearer, token/password di query di-mask', () => {
  const s = maskSecrets('Authorization: Basic dXNlcjpwYXNz\ncookie: sid=abc\nBearer eyJhbGc.x.y ok\nhttps://h/p?user=a&password=s3cr3t&access_token=t0k&q=1');
  assert.doesNotMatch(s, /dXNlcjpwYXNz|sid=abc|eyJhbGc|s3cr3t|t0k/);
  assert.match(s, /Authorization: \*\*\*/);
  assert.match(s, /Bearer \*\*\*/);
  assert.match(s, /user=a&password=\*\*\*&access_token=\*\*\*&q=1/);
  assert.match(errorLine('x', new Error('401 for Bearer abc.def')), /Bearer \*\*\*/);
});

test('setiap catch mencatat ERROR, melempar ulang, atau memberi komentar alasannya', () => {
  const bad: string[] = [];
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.ts'))) {
    const lines = readFileSync(join(SRC, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\bcatch\s*\(|\.catch\(/.test(line)) return;
      if (!/\.error\(|reportError\(|\bthrow\b|\/\//.test(lines.slice(i, i + 6).join('\n'))) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('setiap notifikasi error punya tombol Show Log', () => {
  const bad: string[] = [];
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.ts'))) {
    readFileSync(join(SRC, f), 'utf8').split('\n').forEach((line, i) => {
      if (line.includes('showErrorMessage(') && !line.includes("'Show Log'")) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});
