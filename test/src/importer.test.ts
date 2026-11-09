import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan, conflictsOf, reportMarkdown, summarize, undoImport, importQueue } from '../../src/importer';
import type { ImportPlan } from '../../src/importCommon';

const mk = () => mkdtempSync(join(tmpdir(), 'httpme-imp-'));
const f = (path: string, content = `GET https://a.test/${path}\n`, warnings: string[] = []) => ({ path, content, warnings });
const plan = (...files: ReturnType<typeof f>[]): ImportPlan => ({ name: 'Shop', format: 'postman', files, warnings: [] });

test('applyPlan: tulis semua file per batch, progress n / total, subfolder dibuat', async () => {
  const dir = mk();
  try {
    const seen: string[] = [];
    const r = await applyPlan(plan(f('Shop/a.http'), f('Shop/sub/b.http'), f('Shop/sub/c.http')), { dir, batch: 2, onProgress: (d, t, p) => seen.push(`${d}/${t} ${p}`) });
    assert.equal(r.created.length, 3);
    assert.ok(existsSync(join(dir, 'Shop/sub/b.http')));
    assert.deepEqual(seen, ['1/3 Shop/a.http', '2/3 Shop/sub/b.http', '3/3 Shop/sub/c.http']);
    assert.equal(r.cancelled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('konflik: conflictsOf mendaftar file yang sudah ada; skip (default) / overwrite / keep both', async () => {
  const dir = mk();
  try {
    mkdirSync(join(dir, 'Shop'));
    writeFileSync(join(dir, 'Shop/a.http'), 'GET mine\n');
    writeFileSync(join(dir, 'Shop/b.http'), 'GET mine\n');
    writeFileSync(join(dir, 'Shop/c.http'), 'GET mine\n');
    const p = plan(f('Shop/a.http'), f('Shop/b.http'), f('Shop/c.http'), f('Shop/d.http'));
    assert.deepEqual(await conflictsOf(p, dir), ['Shop/a.http', 'Shop/b.http', 'Shop/c.http']);
    const r = await applyPlan(p, { dir, conflicts: new Map([['Shop/b.http', 'overwrite'], ['Shop/c.http', 'keep']]) });
    assert.equal(readFileSync(join(dir, 'Shop/a.http'), 'utf8'), 'GET mine\n', 'skip');
    assert.match(readFileSync(join(dir, 'Shop/b.http'), 'utf8'), /a\.test\/Shop\/b/);
    assert.equal(readFileSync(join(dir, 'Shop/c.http'), 'utf8'), 'GET mine\n');
    assert.ok(existsSync(join(dir, 'Shop/c 2.http')), 'keep both');
    assert.deepEqual([r.skipped, r.overwritten.map((o) => o.path), r.created.length], [['Shop/a.http'], ['Shop/b.http'], 2]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('selected: hanya item yang dicentang', async () => {
  const dir = mk();
  try {
    const r = await applyPlan(plan(f('Shop/a.http'), f('Shop/b.http')), { dir, selected: new Set(['Shop/b.http']) });
    assert.equal(existsSync(join(dir, 'Shop/a.http')), false);
    assert.equal(r.created.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('path keluar folder tujuan ditolak (..), dicatat sebagai gagal', async () => {
  const dir = mk();
  try {
    const r = await applyPlan(plan(f('../evil.http'), f('Shop/ok.http')), { dir });
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0].error, /outside/);
    assert.equal(r.created.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cancel: berhenti di antara batch, yang sudah ditulis tetap tercatat; Remove created files', async () => {
  const dir = mk();
  try {
    const ac = new AbortController();
    const r = await applyPlan(plan(f('Shop/a.http'), f('Shop/b.http'), f('Shop/c.http'), f('Shop/d.http')), { dir, batch: 2, signal: ac.signal, onProgress: (d) => { if (d >= 2) ac.abort(); } });
    assert.equal(r.cancelled, true);
    assert.equal(r.created.length, 2);
    const u = await undoImport(r);
    assert.equal(u.removed, 2);
    assert.equal(existsSync(join(dir, 'Shop/a.http')), false);
    assert.equal(existsSync(join(dir, 'Shop')), false, 'folder kosong ikut dihapus');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('undoImport: file yang diubah user setelah import tidak dihapus; overwrite dikembalikan', async () => {
  const dir = mk();
  try {
    mkdirSync(join(dir, 'Shop'));
    writeFileSync(join(dir, 'Shop/old.http'), 'GET mine\n');
    const r = await applyPlan(plan(f('Shop/new1.http'), f('Shop/new2.http'), f('Shop/old.http')), { dir, conflicts: new Map([['Shop/old.http', 'overwrite']]) });
    writeFileSync(join(dir, 'Shop/new2.http'), 'GET edited\n');
    const u = await undoImport(r);
    assert.deepEqual([u.removed, u.kept.map((k) => k.replace(/\\/g, '/').split('/').pop())], [1, ['new2.http']]);
    assert.equal(readFileSync(join(dir, 'Shop/old.http'), 'utf8'), 'GET mine\n', 'overwrite dikembalikan');
    assert.equal(existsSync(join(dir, 'Shop/new1.http')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gagal tulis dicatat per file, import lain jalan (Retry failed memakai daftar itu)', async () => {
  const dir = mk();
  try {
    mkdirSync(join(dir, 'ro'));
    chmodSync(join(dir, 'ro'), 0o500);
    const r = await applyPlan(plan(f('ro/a.http'), f('ok/b.http')), { dir });
    if (process.getuid?.() === 0) return; // root menulis ke folder read-only: tidak bisa diuji
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].path, 'ro/a.http');
    assert.equal(r.created.length, 1);
    chmodSync(join(dir, 'ro'), 0o700);
  } finally { chmodSync(join(dir, 'ro'), 0o700); rmSync(dir, { recursive: true, force: true }); }
});

const res = (over: Partial<Awaited<ReturnType<typeof applyPlan>>> = {}) => ({ dir: '/w', total: 6, created: [], overwritten: [], skipped: [], failed: [], cancelled: false, ...over });
const paths = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/w/Shop/r${i}.http`, hash: 'h' }));

test('summarize: berhasil semua', () => {
  const s = summarize(res({ created: paths(6) }), 'Shop');
  assert.deepEqual([s.kind, s.message, s.actions], ['success', 'Imported 6 requests', ['Show in Collections', 'Show report']]);
  assert.match(s.detail, /Shop/);
  assert.equal(summarize(res({ total: 1, created: paths(1) }), 'Shop').message, 'Imported 1 request');
});

test('summarize: sebagian gagal memuat daftar + alasan; gagal total; dibatalkan', () => {
  const part = summarize(res({ total: 5, created: paths(4), failed: [{ path: 'orders/cancel-order.http', error: 'File already exists: orders/cancel-order.http' }] }), 'Shop');
  assert.deepEqual([part.kind, part.message, part.actions], ['partial', 'Imported 4 of 5 requests', ['Retry failed', 'Show log']]);
  assert.match(part.detail, /orders\/cancel-order\.http — File already exists/);
  const all = summarize(res({ total: 2, failed: [{ path: 'a.http', error: 'EACCES' }, { path: 'b.http', error: 'EACCES' }] }), 'Shop');
  assert.deepEqual([all.kind, all.message, all.actions], ['failed', 'Import failed', ['Show log']]);
  const c = summarize(res({ created: paths(2), cancelled: true }), 'Shop');
  assert.deepEqual([c.kind, c.message, c.detail, c.actions], ['cancelled', 'Import cancelled', '2 of 6 files were created', ['Remove created files', 'Keep']]);
});

test('reportMarkdown: ringkasan, peringatan, file gagal', () => {
  const p: ImportPlan = { ...plan(f('Shop/a.http', 'x', ['GraphQL body converted'])), warnings: ['Shop/a.http: GraphQL body converted'] };
  const md = reportMarkdown(p, res({ total: 1, created: [{ path: '/w/Shop/a.http', hash: 'h' }], failed: [{ path: 'Shop/b.http', error: 'boom' }] }));
  assert.match(md, /^# Import report: Shop/);
  assert.match(md, /GraphQL body converted/);
  assert.match(md, /Shop\/b\.http.*boom/);
});

test('importQueue: import diantrekan satu per satu, terpisah dari slot request', async () => {
  const order: string[] = [];
  const slow = importQueue('import', async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 20)); order.push('a-end'); });
  const second = importQueue('import', async () => { order.push('b'); });
  await Promise.all([slow, second]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
});
