import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRunner, serialQueue, singleFlight, step } from '../../src/runner';
import { readChunk, remove, writeChunk } from '../../src/cache';
import { withTempDir } from './helpers/tmp';
import { send } from '../../src/http';
import { startServer } from './helpers/server';

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

test('runner: 2 request ke server lambat jalan bersamaan (total ≈ terlama, bukan dijumlah)', async () => {
  const srv = await startServer(async (req) => { await wait(Number(req.url?.slice(1))); return { body: req.url ?? '' }; });
  try {
    const runner = createRunner();
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      runner.run('a.http', 'GET /300', (signal) => send({ method: 'GET', url: `${srv.url}/300`, headers: [] }, { signal })),
      runner.run('b.http', 'GET /250', (signal) => send({ method: 'GET', url: `${srv.url}/250`, headers: [] }, { signal })),
    ]);
    const total = Date.now() - t0;
    assert.deepEqual([a.body.toString(), b.body.toString()], ['/300', '/250']);
    assert.ok(total >= 290 && total < 520, `total ${total} ms`);
    assert.deepEqual(runner.jobs(), []);
  } finally {
    await srv.close();
  }
});

test('runner: maks 6 bersamaan, sisanya antre dengan posisi Queued n/m', async () => {
  const runner = createRunner({ limit: 2 });
  let active = 0, peak = 0;
  const gates: (() => void)[] = [];
  const task = () => new Promise<void>((ok) => { active++; peak = Math.max(peak, active); gates.push(() => { active--; ok(); }); });
  const all = ['a', 'b', 'c', 'd'].map((k) => runner.run(k, k, task));
  await wait(5);
  assert.deepEqual(runner.jobs().map((j) => `${j.key}:${j.state}`), ['a:running', 'b:running', 'c:queued', 'd:queued']);
  assert.deepEqual(runner.queuePosition('d'), { n: 2, m: 2 });
  assert.equal(runner.queuePosition('a'), undefined);
  gates.shift()!();
  await wait(5);
  assert.deepEqual(runner.jobs().map((j) => `${j.key}:${j.state}`), ['b:running', 'c:running', 'd:queued']);
  assert.deepEqual(runner.queuePosition('d'), { n: 1, m: 1 });
  while (gates.length) { gates.shift()!(); await wait(5); }
  await Promise.all(all);
  assert.equal(peak, 2);
  assert.equal(createRunner().limit, 6);
});

test('runner: onChange dipanggil saat job mulai / antre / selesai', async () => {
  const seen: string[] = [];
  const runner = createRunner({ onChange: () => seen.push(runner.jobs().map((j) => j.state[0]).join('')) });
  await runner.run('a', 'a', async () => 1);
  assert.deepEqual(seen, ['r', '']);
});

test('Send lagi di file yang sama membatalkan request lama (berjalan maupun antre)', async () => {
  const srv = await startServer(async () => { await wait(300); return { body: 'done' }; });
  try {
    const runner = createRunner();
    const first = runner.run('a.http', 'GET 1', (signal) => send({ method: 'GET', url: srv.url, headers: [] }, { signal }));
    await wait(20);
    const second = runner.run('a.http', 'GET 2', (signal) => send({ method: 'GET', url: srv.url, headers: [] }, { signal }));
    await assert.rejects(first, (e: Error & { kind?: string }) => e.kind === 'cancelled');
    assert.equal((await second).body.toString(), 'done');

    const one = createRunner({ limit: 1 });
    const blocker = one.run('x', 'x', () => wait(50));
    const queued = one.run('q', 'q 1', async () => 'old');
    const replaced = one.run('q', 'q 2', async () => 'new');
    await assert.rejects(queued, (e: Error & { kind?: string }) => e.kind === 'cancelled');
    assert.equal(await replaced, 'new');
    await blocker;
  } finally {
    await srv.close();
  }
});

test('step: cancel di tengah tahap async (pre-script / login) langsung berhenti, tahap berikutnya tidak jalan', async () => {
  const ac = new AbortController();
  const ran: string[] = [];
  const chain = (async () => {
    await step(ac.signal, async () => { ran.push('pre'); await wait(1000); });
    await step(ac.signal, async () => { ran.push('request'); });
    await step(ac.signal, async () => { ran.push('post'); });
  })();
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  await assert.rejects(chain, (e: Error & { kind?: string }) => e.kind === 'cancelled');
  assert.ok(Date.now() - t0 < 300);
  assert.deepEqual(ran, ['pre']);
});

test('step: cancel setelah request selesai = post-script tidak dijalankan; signal yang sudah batal ditolak', async () => {
  const ac = new AbortController();
  const ran: string[] = [];
  await step(ac.signal, async () => { ran.push('request'); });
  ac.abort(); // Cancel ditekan tepat setelah response diterima
  await assert.rejects(step(ac.signal, async () => { ran.push('post'); }), (e: Error & { kind?: string }) => e.kind === 'cancelled');
  assert.deepEqual(ran, ['request']);
  assert.equal(await step(new AbortController().signal, async () => 7), 7);
});

test('cancel: request yang masih antre dibatalkan sebelum mulai (task tidak pernah jalan)', async () => {
  const runner = createRunner({ limit: 1 });
  let started = false;
  const blocker = runner.run('x', 'x', () => wait(50).then(() => 'x'));
  const queued = runner.run('q', 'q', async () => { started = true; });
  const byId = runner.run('r', 'r', async () => { started = true; });
  assert.equal(runner.cancel('q'), true);
  assert.equal(runner.cancelJob(runner.jobs().find((j) => j.key === 'r')!.id), true);
  assert.equal(runner.cancel('missing'), false);
  await assert.rejects(queued, (e: Error & { kind?: string }) => e.kind === 'cancelled');
  await assert.rejects(byId, (e: Error & { kind?: string }) => e.kind === 'cancelled');
  assert.equal(await blocker, 'x');
  assert.equal(started, false);
  assert.deepEqual(runner.jobs(), []);
});

test('Cancel All: semua yang berjalan + antre dibatalkan', async () => {
  const srv = await startServer(async () => { await wait(1000); return { body: 'late' }; });
  try {
    const runner = createRunner({ limit: 2 });
    const all = ['a', 'b', 'c'].map((k) => runner.run(k, k, (signal) => send({ method: 'GET', url: srv.url, headers: [] }, { signal })));
    await wait(30);
    const t0 = Date.now();
    assert.equal(runner.cancelAll(), 3);
    for (const p of all) await assert.rejects(p, (e: Error & { kind?: string }) => e.kind === 'cancelled');
    assert.ok(Date.now() - t0 < 500);
    assert.deepEqual(runner.jobs(), []);
  } finally {
    await srv.close();
  }
});

test('serialQueue: 2 request paralel menulis cookie berbeda ke jar Environment yang sama, keduanya tersimpan', () => withTempDir(async (dir) => {
  type Jar = Record<string, string>;
  // baca -> (jeda async, seperti menunggu response) -> tulis: tanpa antrean, tulisan pertama tertimpa
  const setCookie = async (env: string, name: string, value: string) => {
    const jar = (await readChunk<Jar>(dir, env)) ?? {};
    await wait(20);
    await writeChunk(dir, env, { ...jar, [name]: value });
  };
  await Promise.all([setCookie('uat', 'A', '1'), setCookie('uat', 'B', '2')]);
  assert.equal(Object.keys((await readChunk<Jar>(dir, 'uat'))!).length, 1, 'tanpa antrean: satu cookie hilang');

  await remove(dir, 'uat');
  const queue = serialQueue();
  await Promise.all([queue('uat', () => setCookie('uat', 'A', '1')), queue('uat', () => setCookie('uat', 'B', '2')), queue('dev', () => setCookie('dev', 'C', '3'))]);
  assert.deepEqual(await readChunk<Jar>(dir, 'uat'), { A: '1', B: '2' });
  assert.deepEqual(await readChunk<Jar>(dir, 'dev'), { C: '3' });
}));

test('serialQueue: tulisan yang gagal tidak menahan antrean; key berbeda jalan bersamaan', async () => {
  const queue = serialQueue();
  const order: string[] = [];
  const failed = queue('uat', async () => { order.push('1'); throw new Error('disk full'); });
  const next = queue('uat', async () => { order.push('2'); return 'ok'; });
  await assert.rejects(failed, /disk full/);
  assert.equal(await next, 'ok');
  assert.deepEqual(order, ['1', '2']);
  const t0 = Date.now();
  await Promise.all([queue('a', () => wait(60)), queue('b', () => wait(60))]);
  assert.ok(Date.now() - t0 < 110, 'key berbeda tidak saling menunggu');
});

test('singleFlight: 2 request dengan session habis bersamaan = 1 POST /login, keduanya memakai hasil yang sama', async () => {
  let logins = 0;
  const srv = await startServer(async (req) => {
    if (req.method === 'POST' && req.url === '/login') { logins++; await wait(50); return { headers: { 'set-cookie': `SID=s${logins}` }, body: 'ok' }; }
    return { status: 401 };
  });
  try {
    const login = singleFlight(async () => {
      const res = await send({ method: 'POST', url: `${srv.url}/login`, headers: [], body: 'user=a' });
      return res.headers.find(([k]) => k === 'set-cookie')![1];
    });
    const [a, b] = await Promise.all([login(), login()]);
    assert.equal(logins, 1);
    assert.deepEqual([a, b], ['SID=s1', 'SID=s1']);
    assert.equal(await login(), 'SID=s2', 'setelah selesai, session habis berikutnya login lagi');
    assert.equal(logins, 2);
  } finally {
    await srv.close();
  }
});

test('singleFlight: login gagal diteruskan ke semua penunggu, percobaan berikutnya login ulang', async () => {
  let calls = 0;
  const login = singleFlight(async () => { calls++; if (calls === 1) throw new Error('bad password'); return 'ok'; });
  const results = await Promise.allSettled([login(), login()]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(await login(), 'ok');
  assert.equal(calls, 2);
});
