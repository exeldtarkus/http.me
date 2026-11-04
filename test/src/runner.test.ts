import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createRunner } from '../../src/runner';
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
