import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scriptChain } from '../../src/scripts';
import { parseRequest } from '../../src/httpFile';
import { withTempDir } from './helpers/tmp';

const put = (root: string, rel: string, text = '') => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };

test('scriptChain: folder teratas → terdekat, lalu baris < / > atas→bawah, duplikat sekali, inline ikut', () =>
  withTempDir(async (root) => {
    put(root, 'pre-request.js'); put(root, 'a/pre-request.js'); put(root, 'a/b/pre-request.js'); put(root, 'a/b/post-request.js');
    put(root, 'a/b/sign.js'); put(root, 'a/s/x.js');
    const http = join(root, 'a/b/req.http');
    const r = parseRequest('< ./sign.js\n< ../s/x.js\n< ./sign.js\n< {% httpme.vars.set("a", 1) %}\nGET http://x\n\n> ./sign.js\n');
    assert.deepEqual(await scriptChain(root, http, r, 'pre'), [
      { file: join(root, 'pre-request.js') }, { file: join(root, 'a/pre-request.js') }, { file: join(root, 'a/b/pre-request.js') },
      { file: join(root, 'a/b/sign.js') }, { file: join(root, 'a/s/x.js') }, { inline: ' httpme.vars.set("a", 1) ' },
    ]);
    assert.deepEqual(await scriptChain(root, http, r, 'post'), [{ file: join(root, 'a/b/post-request.js') }, { file: join(root, 'a/b/sign.js') }]);
  }));

test('scriptChain: @no-scripts / @no-pre / @no-post', () =>
  withTempDir(async (root) => {
    put(root, 'pre-request.js'); put(root, 'post-request.js');
    const http = join(root, 'r.http');
    const chain = (t: string, k: 'pre' | 'post') => scriptChain(root, http, parseRequest(t), k);
    assert.deepEqual(await chain('# @no-scripts\nGET http://x\n', 'pre'), []);
    assert.deepEqual(await chain('# @no-scripts\nGET http://x\n', 'post'), []);
    assert.deepEqual(await chain('# @no-pre\nGET http://x\n', 'pre'), []);
    assert.deepEqual(await chain('# @no-pre\nGET http://x\n', 'post'), [{ file: join(root, 'post-request.js') }]);
    assert.deepEqual(await chain('# @no-post\nGET http://x\n', 'post'), []);
  }));

test('scriptChain: path tidak ada / berkoma = error; .http di luar root hanya folder sendiri', () =>
  withTempDir(async (root) => {
    const http = join(root, 'r.http');
    await assert.rejects(scriptChain(root, http, parseRequest('< ./nope.js\nGET http://x\n'), 'pre'), /Script file not found: \.\/nope\.js/);
    await assert.rejects(scriptChain(root, http, parseRequest('< ./a.js, ./b.js\nGET http://x\n'), 'pre'), /one script path per line/);
    put(root, 'out/pre-request.js'); put(root, 'pre-request.js');
    assert.deepEqual(await scriptChain(join(root, 'ws'), join(root, 'out/r.http'), parseRequest('GET http://x\n'), 'pre'), [{ file: join(root, 'out/pre-request.js') }]);
  }));
