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

import { buildCollectionTree, buildCookieTree, type TreeNode } from '../../src/dashboard';

test('buildCollectionTree: folder bersarang, folder dulu lalu file, jumlah request, folder kosong (.httpmekeep)', () => {
  const t = buildCollectionTree([
    { path: 'api/users/list.http', text: req('GET') },
    { path: 'api/users/create.http', text: req('POST') },
    { path: 'api/orders.http', text: `${req('GET')}\n${req('DELETE')}` },
    { path: 'api/_auth.http', text: '# @auth bearer token=x\n' },
    { path: 'root.http', text: req('PATCH') },
  ], ['api/users', 'empty/nested']);
  assert.deepEqual(t.map((n) => [n.type, n.name, n.path]), [['folder', 'api', 'api'], ['folder', 'empty', 'empty'], ['file', 'root.http', 'root.http']]);
  const api = t[0] as TreeNode;
  assert.deepEqual(api.children!.map((n) => [n.type, n.name]), [['folder', 'users'], ['file', '_auth.http'], ['file', 'orders.http']]);
  assert.equal(api.count, 4, 'request di bawah folder (rekursif)');
  const orders = api.children![2];
  assert.deepEqual([orders.requests, orders.method], [2, 'GET']);
  assert.equal(api.children![1].method, undefined, '_auth.http bukan request');
  assert.equal(t[1].children![0].name, 'nested');
  assert.deepEqual(t[1].children![0].children, []);
  assert.equal(api.children![0].children![1].title, 't');
});

test('buildCookieTree: Environment → domain → cookie, nilai di-mask, kedaluwarsa ditandai', () => {
  const now = 100;
  const c = (domain: string, name: string, over = {}): Cookie => ({ name, value: 'secretvalue', domain, hostOnly: false, path: '/', secure: true, httpOnly: false, created: 0, ...over });
  const t = buildCookieTree([{ env: 'dev', cookies: [c('b.test', 'x'), c('a.test', 'y', { expires: 50 }), c('a.test', 'z')] }, { env: '', cookies: [] }], now, (v) => `${v.slice(0, 2)}…`);
  assert.deepEqual(t.map((e) => [e.env, e.label, e.cookies]), [['dev', 'dev', 3], ['', 'No Environment', 0]]);
  assert.deepEqual(t[0].domains.map((d) => [d.domain, d.cookies.length]), [['a.test', 2], ['b.test', 1]]);
  const y = t[0].domains[0].cookies.find((x) => x.name === 'y')!;
  assert.deepEqual([y.value, y.expired, y.secure, y.path], ['se…', true, true, '/']);
});

test('dashboard.js: flatten (tree → baris, filter membuka folder), canDrop, parentOf', () => {
  const { flatten, canDrop, parentOf } = createRequire(__filename)(join(__dirname, '../../../media/webview/dashboard.js')) as {
    flatten(t: unknown[], open: Set<string>, q: string): { node: { path: string }; depth: number }[]; canDrop(from: string[], to: string): boolean; parentOf(p: string): string;
  };
  const tree = [{ type: 'folder', name: 'api', path: 'api', count: 2, children: [{ type: 'file', name: 'a.http', path: 'api/a.http', children: undefined }, { type: 'folder', name: 'sub', path: 'api/sub', count: 0, children: [] }] }, { type: 'file', name: 'r.http', path: 'r.http' }];
  assert.deepEqual(flatten(tree, new Set(), '').map((r) => r.node.path), ['api', 'r.http'], 'tertutup');
  assert.deepEqual(flatten(tree, new Set(['api']), '').map((r) => [r.node.path, r.depth]), [['api', 0], ['api/a.http', 1], ['api/sub', 1], ['r.http', 0]]);
  assert.deepEqual(flatten(tree, new Set(), 'a.http').map((r) => r.node.path), ['api', 'api/a.http'], 'filter membuka folder induk');
  assert.equal(canDrop(['api'], 'api'), false);
  assert.equal(canDrop(['api'], 'api/sub'), false, 'folder ke dalam dirinya sendiri');
  assert.equal(canDrop(['api/a.http'], 'api'), false, 'sudah di folder itu');
  assert.equal(canDrop(['api/a.http'], ''), true);
  assert.equal(canDrop(['r.http'], 'api'), true);
  assert.equal(parentOf('api/sub/x.http'), 'api/sub');
  assert.equal(parentOf('r.http'), '');
});

test('dashboard.js deleteAction: Delete memilih aksi sesuai tab; Globals / No Environment tidak pernah bisa dihapus', () => {
  const { deleteAction } = createRequire(__filename)(join(__dirname, '../../../media/webview/dashboard.js')) as {
    deleteAction(tab: string, sel: Set<string>, cookie: { id: string; args: object } | null): { id: string; args: object } | undefined;
  };
  assert.deepEqual(deleteAction('collections', new Set(['a', 'b/c.http']), null), { id: 'file.delete', args: { paths: ['a', 'b/c.http'] } });
  assert.equal(deleteAction('collections', new Set(), null), undefined);
  const stale = { id: 'cookie.delete', args: {} };
  assert.equal(deleteAction('history', new Set(['x']), stale), undefined, 'tab History: Delete tidak menghapus');
  assert.equal(deleteAction('backups', new Set(['x']), stale), undefined, 'tab Backups: Delete tidak menghapus');
  assert.deepEqual(deleteAction('cookies', new Set(), stale), stale);
  assert.deepEqual(deleteAction('environments', new Set(['env:dev']), null), { id: 'env.delete', args: { name: 'dev' } });
  assert.equal(deleteAction('environments', new Set(), null), undefined, 'Globals / No Environment tidak punya pilihan');
  assert.equal(deleteAction('environments', new Set(['env:']), null), undefined, 'nama kosong = Globals');
  const c = { id: 'cookie.delete', args: { name: 'sid' } };
  assert.deepEqual(deleteAction('cookies', new Set(), c), c);
  assert.equal(deleteAction('cookies', new Set(), null), undefined);
});

test('Dashboard: tombol Export… dan menu Export… memakai httpme.export; Delete lewat handler dokumen', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const js = fs.readFileSync(join(__dirname, '../../../media/webview/dashboard.js'), 'utf8');
  const cmd = fs.readFileSync(join(__dirname, '../../../src/dashboardCommand.ts'), 'utf8');
  assert.match(js, /textContent: 'Export…', onclick: \(\) => act\('coll\.export'\)/);
  assert.match(js, /id: 'folder\.export'/);
  assert.match(cmd, /'coll\.export': \(\) => exec\('httpme\.export'\)/);
  assert.match(cmd, /'folder\.export': file\('httpme\.export'\)/);
  assert.match(js, /document\.addEventListener\('keydown', [\s\S]{0,300}deleteAction\(/);
  assert.doesNotMatch(js, /ev\.key === 'Delete'/, 'Delete tidak lagi per-baris (hilang saat render ulang)');
});

test('Open Dashboard menutup panel bawah http.me hanya bila view Response terlihat', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const ed = fs.readFileSync(join(__dirname, '../../../src/httpEditor.ts'), 'utf8');
  const cmd = fs.readFileSync(join(__dirname, '../../../src/dashboardCommand.ts'), 'utf8');
  assert.match(ed, /export async function closeOutputPanel\(\)[\s\S]{0,200}output\.view\?\.visible[\s\S]{0,120}workbench\.action\.closePanel/);
  assert.match(cmd, /registerCommand\('httpme\.openDashboard', async \(\) => \{\s*await closeOutputPanel\(\);/);
});
