import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { summarizeCollections, summarizeCookies, summarizeEnvironments, shouldSkipDir } from '../../src/dashboard';
import type { Cookie } from '../../src/cookieJar';

const req = (m: string, u = 'https://a.test') => `### t\n${m} ${u}\n`;

test('summarizeCollections: kelompok per folder teratas, hitung request & method; file multi-request dihitung per blok', () => {
  const s = summarizeCollections([
    { path: 'api/users/list.http', text: req('GET') },
    { path: 'api/users/create.http', text: req('POST') },
    { path: 'api/orders.http', text: `${req('GET')}\n${req('GET', 'https://b.test')}\n${req('DELETE')}` },
    { path: 'shop/a.http', text: req('PUT') },
    { path: 'root.http', text: req('PATCH') },
    { path: 'api/_auth.http', text: '# @auth bearer token=x\n' },
  ]);
  assert.equal(s.requests, 7);
  assert.equal(s.files, 5, '_auth.http dan file tanpa request tidak dihitung sebagai file request');
  assert.deepEqual(s.collections.map((c) => [c.name, c.requests, c.folders]), [['api', 5, 1], ['shop', 1, 0], ['(root)', 1, 0]]);
  assert.deepEqual(s.collections[0].methods, { GET: 3, POST: 1, DELETE: 1 });
  assert.deepEqual(s.methods, { GET: 3, POST: 1, DELETE: 1, PUT: 1, PATCH: 1 });
});

test('summarizeCollections: kosong', () => {
  assert.deepEqual(summarizeCollections([]), { requests: 0, files: 0, methods: {}, collections: [] });
});

test('shouldSkipDir: node_modules, .git, folder titik, output build', () => {
  for (const d of ['node_modules', '.git', '.httpme', 'out', 'dist', 'target']) assert.equal(shouldSkipDir(d), true, d);
  assert.equal(shouldSkipDir('api'), false);
});

test('summarizeEnvironments: total, NULL, secret, aktif; NULL secret yang belum diisi dihitung', () => {
  const s = summarizeEnvironments([
    { name: 'dev', vars: [{ key: 'a', value: '1' }, { key: 'b', value: null }, { key: 't', value: null, secret: true }] },
    { name: 'prod', vars: [{ key: 'a', value: null }, { key: 'b', value: null }, { key: 't', value: null, secret: true }] },
  ], 'dev', { dev: ['t'], prod: [] });
  assert.deepEqual(s.environments, [
    { name: 'dev', active: true, variables: 3, nulls: 1, secrets: 1 },
    { name: 'prod', active: false, variables: 3, nulls: 3, secrets: 1 },
  ]);
  assert.equal(s.active, 'dev');
  assert.equal(s.totalNulls, 4);
  assert.equal(summarizeEnvironments([], undefined, {}).active, undefined);
});

const ck = (domain: string, over: Partial<Cookie> = {}): Cookie => ({ name: 'n', value: 'v', domain, hostOnly: false, path: '/', secure: false, httpOnly: false, created: 0, ...over });

test('summarizeCookies: per Environment jumlah cookie, domain unik, kedaluwarsa, session', () => {
  const now = 1_000_000;
  const s = summarizeCookies([
    { env: 'dev', cookies: [ck('a.test'), ck('a.test', { name: 'm' }), ck('b.test', { expires: now - 1 }), ck('b.test', { name: 'z', expires: now + 5 })] },
    { env: '', cookies: [] },
  ], now);
  assert.deepEqual(s.environments, [
    { env: 'dev', label: 'dev', cookies: 4, domains: 2, expired: 1, session: 2 },
    { env: '', label: 'No Environment', cookies: 0, domains: 0, expired: 0, session: 0 },
  ]);
  assert.equal(s.total, 4);
});

import { createRequire } from 'node:module';
import { join } from 'node:path';
test('dashboard.js segments: urutan tetap, method lain digabung, persen', () => {
  const { segments } = createRequire(__filename)(join(__dirname, '../../../media/webview/dashboard.js')) as { segments(m: Record<string, number>): { method: string; n: number; pct: number }[] };
  const s = segments({ DELETE: 1, GET: 2, PROPFIND: 1 });
  assert.deepEqual(s.map((x) => [x.method, x.n]), [['GET', 2], ['DELETE', 1], ['other', 1]]);
  assert.equal(s[0].pct, 50);
  assert.deepEqual(segments({}), []);
});
