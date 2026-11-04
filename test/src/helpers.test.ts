import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './helpers/server';
import { withTempDir } from './helpers/tmp';

test('helper server: port acak, handler menerima method + body, close menutup port', async () => {
  const srv = await startServer(async (req, body) => ({ status: 201, headers: { 'x-m': req.method ?? '' }, body: `got ${body}` }));
  const other = await startServer(async () => ({ body: '' }));
  try {
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(srv.url, other.url, 'port acak per server');
    const res = await fetch(`${srv.url}/x`, { method: 'POST', body: 'hi' });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-m'), 'POST');
    assert.equal(await res.text(), 'got hi');
  } finally {
    await srv.close();
    await other.close();
  }
  await assert.rejects(fetch(srv.url));
});

test('helper temp dir: dibuat untuk test lalu dihapus walau test gagal', async () => {
  let kept = '';
  await withTempDir(async (dir) => {
    kept = dir;
    writeFileSync(join(dir, 'a.json'), '{}');
    assert.ok(existsSync(join(dir, 'a.json')));
  });
  assert.equal(existsSync(kept), false);
  await assert.rejects(withTempDir(async (dir) => { kept = dir; throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(kept), false);
});
