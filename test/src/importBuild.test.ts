import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildPlan, runInWorker } from '../../src/importBuild';

const spec = (n: number) => {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) paths[`/r${i % 50}/{id}/item${i}`] = { get: { tags: [`t${i % 50}`], operationId: `op${i}`, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
    post: { tags: [`t${i % 50}`], operationId: `post${i}`, requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Big' } } } } } };
  const props: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) props[`p${i}`] = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } } };
  return JSON.stringify({ openapi: '3.0.0', info: { title: 'Big' }, servers: [{ url: 'https://x.test' }], paths, components: { schemas: { Big: { type: 'object', properties: props } } } });
};

test('buildPlan: format, plan dan info baris preview (method, judul, jenis); error jadi pesan', () => {
  const r = buildPlan({ text: spec(2), envs: [] });
  assert.equal(r.format, 'openapi');
  const f = r.plan!.files.find((x) => x.path.endsWith('op0.http'))!;
  assert.deepEqual([f.info?.method, f.info?.kind], ['GET', 'request']);
  assert.equal(buildPlan({ text: '{"foo":1}', envs: [] }).error?.includes('not a supported'), true);
  assert.deepEqual(buildPlan({ text: "curl 'https://a.test'", envs: [] }), { format: 'curl' });
  assert.deepEqual(buildPlan({ text: JSON.stringify({ name: 'E', values: [] }), envs: [] }), { format: 'postman-environment' });
});

test('runInWorker: hasil sama dengan buildPlan, dan event loop utama tetap berjalan selama proses besar', async () => {
  const text = spec(5000);
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 10);
  try {
    const r = await runInWorker({ text, envs: [] });
    assert.equal(r.plan!.files.length, 10000);
    assert.ok(worst < 120, `event loop terblokir ${worst} ms`);
  } finally { clearInterval(timer); }
});

test('runInWorker: dibatalkan lewat AbortSignal', async () => {
  const ac = new AbortController();
  const p = runInWorker({ text: spec(5000), envs: [] }, ac.signal);
  ac.abort();
  await assert.rejects(p, /cancel/i);
});

test('runInWorker: spec rusak = error dengan pesan jelas', async () => {
  await assert.rejects(runInWorker({ text: '{bad', envs: [] }), /not a supported/);
});
