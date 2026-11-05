import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileBody, multipartBody } from '../../src/bodyStream';
import { send } from '../../src/http';

const collect = async (b: { stream(): AsyncIterable<Buffer | Uint8Array> }) => { const out: Buffer[] = []; for await (const c of b.stream()) out.push(Buffer.from(c)); return out; };

test('multipartBody: bagian teks + file `< ./path`, CRLF, Content-Length tepat, file di-stream per potongan (tidak satu Buffer utuh)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'httpme-mp-'));
  try {
    const big = randomBytes(600 * 1024);
    await writeFile(join(dir, 'big.bin'), big);
    const text = ['--XB', 'Content-Disposition: form-data; name="title"', '', 'My Doc', '--XB', 'Content-Disposition: form-data; name="file"; filename="big.bin"', 'Content-Type: application/octet-stream', '', '< ./big.bin', '--XB--'].join('\n');
    const mp = await multipartBody(text, 'multipart/form-data; boundary=XB', (p) => join(dir, p));
    const chunks = await collect(mp);
    const all = Buffer.concat(chunks);
    assert.equal(all.length, mp.length);
    assert.ok(Math.max(...chunks.map((c) => c.length)) <= 128 * 1024, 'tidak ada potongan besar');
    const head = Buffer.from('--XB\r\nContent-Disposition: form-data; name="title"\r\n\r\nMy Doc\r\n--XB\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n');
    assert.deepEqual(all.subarray(0, head.length), head);
    assert.deepEqual(all.subarray(head.length, head.length + big.length), big);
    assert.equal(all.subarray(head.length + big.length).toString(), '\r\n--XB--\r\n');
    assert.equal((await collect(mp)).reduce((n, c) => n + c.length, 0), mp.length, 'stream() bisa dipanggil ulang (redirect 307)');
    await assert.rejects(multipartBody('--XB\n\n< ./hilang\n--XB--', 'multipart/form-data; boundary=XB', (p) => join(dir, p)), /hilang/);
    await assert.rejects(multipartBody('x', 'multipart/form-data', (p) => p), /boundary/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('send: upload multipart dan body dari file lewat server lokal — byte sampai utuh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'httpme-up-'));
  const got: { len?: string; body: Buffer }[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => { got.push({ len: req.headers['content-length'], body: Buffer.concat(parts) }); res.writeHead(200).end('ok'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/up`;
  try {
    const data = randomBytes(1024 * 1024 + 123);
    await writeFile(join(dir, 'f.bin'), data);
    const raw = await fileBody(join(dir, 'f.bin'));
    const a = await send({ method: 'POST', url, headers: [['Content-Type', 'application/octet-stream']], body: raw });
    assert.equal(a.status, 200);
    assert.equal(got[0].len, String(data.length));
    assert.deepEqual(got[0].body, data);
    const mp = await multipartBody(`--B\nContent-Disposition: form-data; name="f"; filename="f.bin"\n\n< f.bin\n--B--`, 'multipart/form-data; boundary=B', (p) => join(dir, p));
    const b = await send({ method: 'POST', url, headers: [['Content-Type', 'multipart/form-data; boundary=B']], body: mp });
    assert.equal(b.status, 200);
    assert.equal(got[1].len, String(mp.length));
    assert.ok(got[1].body.includes(data));
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
