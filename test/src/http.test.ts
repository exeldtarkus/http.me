import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { allowedMethods, isBinaryType, MAX_BODY_MEMORY, send } from '../../src/http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from './helpers/tmp';
import { startServer } from './helpers/server';

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

test('send: status, header, body, ukuran (byte) dan waktu (ms)', async () => {
  const srv = await startServer(async () => { await wait(30); return { status: 201, headers: { 'x-a': '1', 'content-type': 'text/plain' }, body: 'héllo' }; });
  try {
    const res = await send({ method: 'GET', url: `${srv.url}/p?q=1`, headers: [] });
    assert.equal(res.status, 201);
    assert.equal(res.statusText, 'Created');
    assert.ok(res.headers.some(([k, v]) => k === 'x-a' && v === '1'));
    assert.equal(res.body.toString('utf8'), 'héllo');
    assert.equal(res.size, 6, 'ukuran = byte, bukan karakter');
    assert.ok(res.timeMs >= 25 && res.timeMs < 2000, `timeMs ${res.timeMs}`);
    assert.equal(res.url, `${srv.url}/p?q=1`);
  } finally {
    await srv.close();
  }
});

test('send: header request sampai ke server (nama asli, nilai berulang)', async () => {
  let got: Record<string, string | string[] | undefined> = {};
  const srv = await startServer(async (req) => { got = req.headers; return { body: '' }; });
  try {
    await send({ method: 'GET', url: srv.url, headers: [['X-Token', 'abc'], ['Accept', 'a/b'], ['X-Multi', '1'], ['X-Multi', '2']] });
    assert.equal(got['x-token'], 'abc');
    assert.equal(got.accept, 'a/b');
    assert.equal(got['x-multi'], '1, 2');
  } finally {
    await srv.close();
  }
});

test('send: timeout memutus request lambat dengan pesan jelas', async () => {
  const srv = await startServer(async () => { await wait(1000); return { body: 'late' }; });
  try {
    await assert.rejects(send({ method: 'GET', url: srv.url, headers: [] }, { timeoutMs: 50 }),
      (e: Error & { kind?: string }) => e.kind === 'timeout' && /timed out after 0\.05 s/.test(e.message));
  } finally {
    await srv.close();
  }
});

test('send: cancel lewat AbortSignal (saat jalan maupun sebelum mulai) = kind cancelled', async () => {
  const srv = await startServer(async () => { await wait(1000); return { body: 'late' }; });
  try {
    const ac = new AbortController();
    const p = send({ method: 'GET', url: srv.url, headers: [] }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    await assert.rejects(p, (e: Error & { kind?: string }) => e.kind === 'cancelled' && e.message === 'Cancelled');
    assert.ok(Date.now() - t0 < 500, 'cancel tidak menunggu server');
    await assert.rejects(send({ method: 'GET', url: srv.url, headers: [] }, { signal: AbortSignal.abort() }), (e: Error & { kind?: string }) => e.kind === 'cancelled');
  } finally {
    await srv.close();
  }
});

test('send: error jaringan / URL salah = kind network dengan pesan asli', async () => {
  const srv = await startServer(async () => ({ body: '' }));
  const url = srv.url;
  await srv.close();
  await assert.rejects(send({ method: 'GET', url, headers: [] }), (e: Error & { kind?: string }) => e.kind === 'network' && /ECONNREFUSED/.test(e.message));
  await assert.rejects(send({ method: 'GET', url: 'not a url', headers: [] }), (e: Error & { kind?: string }) => e.kind === 'network' && /Invalid URL/.test(e.message));
  await assert.rejects(send({ method: 'GET', url: 'ftp://x/y', headers: [] }), /Unsupported protocol ftp:/);
});

test('method: POST/PUT/PATCH/DELETE/OPTIONS/QUERY sampai ke server dengan body yang benar', async () => {
  const seen: string[] = [];
  const srv = await startServer(async (req, body) => { seen.push(`${req.method} ${body}`); return { body: 'ok' }; });
  try {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'QUERY']) {
      const res = await send({ method: m, url: srv.url, headers: [['Content-Type', 'application/json']], body: `{"m":"${m}"}` });
      assert.equal(res.status, 200, m);
    }
    assert.deepEqual(seen, ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'QUERY'].map((m) => `${m} {"m":"${m}"}`));
  } finally {
    await srv.close();
  }
});

test('method: GET/HEAD tidak mengirim body walau diketik; HEAD = body kosong', async () => {
  const seen: string[] = [];
  const srv = await startServer(async (req, body) => { seen.push(`${req.method}:${body}:${req.headers['content-length'] ?? '-'}`); return { headers: { 'content-length': '5' }, body: 'hello' }; });
  try {
    const get = await send({ method: 'GET', url: srv.url, headers: [], body: 'typed' });
    const head = await send({ method: 'HEAD', url: srv.url, headers: [], body: 'typed' });
    assert.deepEqual(seen, ['GET::-', 'HEAD::-']);
    assert.equal(get.body.toString(), 'hello');
    assert.equal(head.body.length, 0);
    assert.equal(head.size, 0);
    assert.ok(head.headers.some(([k, v]) => k === 'content-length' && v === '5'));
  } finally {
    await srv.close();
  }
});

test('OPTIONS: daftar method dari Allow / Access-Control-Allow-Methods', () => {
  assert.deepEqual(allowedMethods([['allow', 'GET, POST,options']]), ['GET', 'POST', 'OPTIONS']);
  assert.deepEqual(allowedMethods([['access-control-allow-methods', 'PUT, QUERY'], ['allow', 'GET, PUT']]), ['GET', 'PUT', 'QUERY']);
  assert.deepEqual(allowedMethods([['x', 'y']]), []);
});

test('body besar: hanya potongan awal di memory, body utuh ditulis ke file (0600)', () => withTempDir(async (dir) => {
  const big = 'x'.repeat(5000) + 'END';
  const srv = await startServer(async () => ({ headers: { 'content-type': 'text/plain' }, body: big }));
  try {
    const bodyFile = join(dir, 'body.txt');
    const res = await send({ method: 'GET', url: srv.url, headers: [] }, { maxMemory: 1024, bodyFile });
    assert.equal(res.truncated, true);
    assert.equal(res.binary, false);
    assert.equal(res.body.length, 1024);
    assert.equal(res.size, big.length);
    assert.equal(res.bodyFile, bodyFile);
    assert.equal(readFileSync(bodyFile, 'utf8'), big);
    if (process.platform !== 'win32') assert.equal(statSync(bodyFile).mode & 0o777, 0o600);
    const noFile = await send({ method: 'GET', url: srv.url, headers: [] }, { maxMemory: 1024 });
    assert.deepEqual([noFile.truncated, noFile.body.length, noFile.size, noFile.bodyFile], [true, 1024, big.length, undefined]);
    assert.equal(MAX_BODY_MEMORY, 1024 * 1024);
  } finally {
    await srv.close();
  }
}));

test('body biner: tidak ditahan di memory, ditulis utuh ke file; body kecil tidak membuat file', () => withTempDir(async (dir) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const srv = await startServer(async (req) => (req.url === '/img' ? { headers: { 'content-type': 'image/png' }, body: png } : { headers: { 'content-type': 'application/json' }, body: '{}' }));
  try {
    const bodyFile = join(dir, 'body.bin');
    const res = await send({ method: 'GET', url: `${srv.url}/img`, headers: [] }, { bodyFile });
    assert.deepEqual([res.binary, res.truncated, res.body.length, res.size], [true, false, 0, png.length]);
    assert.deepEqual(readFileSync(bodyFile), png);
    const small = join(dir, 'small.bin');
    const json = await send({ method: 'GET', url: `${srv.url}/json`, headers: [] }, { bodyFile: small });
    assert.deepEqual([json.binary, json.truncated, json.body.toString(), json.bodyFile], [false, false, '{}', undefined]);
    assert.equal(existsSync(small), false);
  } finally {
    await srv.close();
  }
}));

test('isBinaryType: gambar / pdf / zip / octet-stream biner; teks, JSON, XML, JS bukan', () => {
  for (const t of ['image/png', 'application/pdf', 'application/zip', 'application/octet-stream', 'audio/mpeg', 'video/mp4', 'font/woff2', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']) assert.equal(isBinaryType(t), true, t);
  for (const t of ['text/html; charset=utf-8', 'application/json', 'application/problem+json', 'application/xml', 'image/svg+xml', 'application/javascript', 'application/x-www-form-urlencoded', '']) assert.equal(isBinaryType(t), false, t);
});
