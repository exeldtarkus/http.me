import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { runScript, type ScriptContext } from '../../src/scripts';

const kv = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { map: m, store: { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v), unset: (k: string) => void m.delete(k), has: (k: string) => m.has(k) } };
};
const ctx = (o: Partial<ScriptContext> = {}): ScriptContext => ({
  request: { method: 'GET', url: 'http://x/a', headers: [['Accept', 'text/plain']], body: undefined },
  environment: kv({ token: 't1' }).store, vars: new Map(), cookies: { get: (n) => (n === 'sid' ? 'abc' : undefined), all: () => [{ name: 'sid', value: 'abc' }] },
  ...o,
});
const run = (code: string, c = ctx()) => runScript(code, { file: '/w/s.js', root: '/w' }, c);

test('runScript: httpme.request bisa diubah (method, url, header set/get/remove, body)', async () => {
  const c = ctx();
  const r = await run(`
    httpme.request.method = 'POST';
    httpme.request.url += '?q=1';
    httpme.request.headers.set('X-A', '1');
    httpme.request.headers.set('accept', 'application/json');
    httpme.request.headers.remove('x-none');
    httpme.request.body = JSON.stringify({ a: httpme.request.headers.get('x-a') });
  `, c);
  assert.equal(r.error, undefined);
  assert.deepEqual(c.request, { method: 'POST', url: 'http://x/a?q=1', headers: [['Accept', 'application/json'], ['X-A', '1']], body: '{"a":"1"}' });
});

test('runScript: environment / vars / cookies', async () => {
  const env = kv({ token: 't1' });
  const c = ctx({ environment: env.store });
  const r = await run(`
    httpme.environment.set('next', httpme.environment.get('token') + '!');
    httpme.environment.unset('token');
    httpme.vars.set('n', 5);
    console.log(httpme.vars.get('n'), httpme.vars.has('n'), httpme.cookies.get('sid'), httpme.cookies.all().length);
  `, c);
  assert.equal(r.error, undefined);
  assert.deepEqual([...env.map], [['next', 't1!']]);
  assert.equal(c.vars.get('n'), '5', 'vars disimpan sebagai teks');
  assert.deepEqual(r.console, [{ level: 'log', text: '5 true abc 1' }]);
});

test('runScript: response + test / expect (lulus, gagal, async), skip, console level', async () => {
  const c = ctx({ response: { status: 200, headers: [['Content-Type', 'application/json']], body: '{"id":7,"tags":["a"]}', time: 120 } });
  const r = await run(`
    const j = httpme.response.json();
    httpme.test('status 200', () => httpme.expect(httpme.response.status).toBe(200));
    httpme.test('id', () => { httpme.expect(j).toEqual({ id: 7, tags: ['a'] }); httpme.expect(j.tags).toContain('a'); });
    httpme.test('fast', () => httpme.expect(httpme.response.time).toBeLessThan(100));
    httpme.test('async', async () => { await null; httpme.expect(httpme.response.headers.get('content-type')).toMatch(/json/); });
    httpme.test('not', () => httpme.expect(1).not.toBe(1));
    console.warn('w', { a: 1 }); console.error(new Error('boom'));
    httpme.skip();
  `, c);
  assert.equal(r.error, undefined);
  assert.equal(r.skipped, true);
  assert.deepEqual(r.tests.map((t) => [t.name, t.passed]), [['status 200', true], ['id', true], ['fast', false], ['async', true], ['not', false]]);
  assert.match(r.tests[2].error!, /120.*100|less than/i);
  assert.deepEqual(r.console.map((x) => x.level), ['warn', 'error']);
  assert.equal(r.console[0].text, "w { a: 1 }");
  assert.match(r.console[1].text, /boom/);
});

test('runScript: throw / syntax error = error dengan baris; konteks baru tiap run; top-level await', async () => {
  const r = await run('const a = 1;\nthrow new Error("nope");');
  assert.match(r.error!, /nope/);
  assert.match(r.error!, /s\.js:2/);
  assert.match((await run('const = ;')).error!, /SyntaxError|Unexpected/);
  await run('globalThis.leak = 1;');
  assert.deepEqual((await run('console.log(typeof leak)')).console, [{ level: 'log', text: 'undefined' }]);
  assert.deepEqual((await run('await new Promise((ok) => setTimeout(ok, 5)); console.log("done")')).console, [{ level: 'log', text: 'done' }]);
});

test('runScript: infinite loop dihentikan (batas sinkron), await yang tidak selesai kena batas total, cancel', async () => {
  const limits = { syncMs: 100, totalMs: 300 };
  const loop = await runScript('while (true) {}', { file: '/w/s.js', root: '/w', limits }, ctx());
  assert.match(loop.error!, /timed out after 100 ms/);
  const hang = await runScript('await new Promise(() => {})', { file: '/w/s.js', root: '/w', limits }, ctx());
  assert.match(hang.error!, /timed out after 0\.3 s/);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const cancelled = await runScript('await new Promise(() => {})', { file: '/w/s.js', root: '/w', signal: ac.signal }, ctx());
  assert.equal(cancelled.error, 'Cancelled');
});

test('runScript: require hanya crypto/buffer/url/querystring/util + .js lokal di repo; tanpa process/fs/fetch', async () => {
  const { withTempDir } = await import('./helpers/tmp');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  await withTempDir(async (dir) => {
    const root = join(dir, 'repo');
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib/sign.js'), 'const { createHash } = require("crypto");\nmodule.exports = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);\n');
    writeFileSync(join(dir, 'outside.js'), 'module.exports = 1;\n');
    const o = { file: join(root, 's.js'), root };
    const ok = await runScript(`
      const sign = require('./lib/sign');
      console.log(sign('a'), typeof require('node:util').format, typeof require('buffer').Buffer, typeof require('url').URL, typeof require('querystring').stringify);
      console.log(typeof process, typeof fetch, typeof require);
    `, o, ctx());
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.console.map((x) => x.text), ['ca978112 function function function function', 'undefined undefined function']);
    for (const bad of ["require('fs')", "require('node:child_process')", "require('../outside.js')", "require('http')"]) {
      const r = await runScript(bad, o, ctx());
      assert.match(r.error!, /not allowed/, bad);
    }
  });
});
