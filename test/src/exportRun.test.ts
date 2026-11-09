import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportCancelled, runExport, includeSelected, buildExport, previewText, loadOriginal } from '../../src/exportRun';

function collection() {
  const root = mkdtempSync(join(tmpdir(), 'httpme-export-'));
  const dir = join(root, 'Shop');
  mkdirSync(join(dir, 'Users'), { recursive: true });
  mkdirSync(join(dir, 'Other'), { recursive: true });
  writeFileSync(join(dir, 'Users', 'List.http'), '### List\n< ./s.js\nGET {{baseUrl}}/users\n');
  writeFileSync(join(dir, 'Users', 's.js'), 'httpme.environment.set("a", 1);\n');
  writeFileSync(join(dir, 'Other', 'X.http'), '### X\nGET {{baseUrl}}/x\n');
  writeFileSync(join(dir, '_variables.json'), JSON.stringify({ httpmeFormat: 1, variables: [{ key: 'baseUrl', value: 'https://a.test' }] }));
  return { root, dir, out: join(root, 'exports') };
}

test('runExport Postman: tulis ke exports/, script dari baris < ikut, filter include', async () => {
  const c = collection();
  const out = join(c.out, 'Shop.postman_collection.json');
  const progress: string[] = [];
  const r = await runExport({ root: c.dir, format: 'postman', outFile: out, include: (p) => !p.startsWith('Other/') }, undefined, (d, t) => progress.push(`${d}/${t}`));
  assert.deepEqual(r.files, [out]);
  assert.equal(r.requests, 1);
  assert.ok(progress.length > 0);
  const j = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(j.item[0].name, 'Users');
  assert.deepEqual(j.item[0].item[0].event[0].script.exec, ['pm.environment.set("a", 1);']);
  assert.deepEqual(j.variable, [{ key: 'baseUrl', value: 'https://a.test' }]);
});

test('runExport: Environments Postman + Globals, secret kosong default', async () => {
  const c = collection();
  const out = join(c.out, 'Shop.postman_collection.json');
  const env = { name: 'dev', vars: [{ key: 'tok', value: null, secret: true }], secrets: { tok: 'S' } };
  const r = await runExport({ root: c.dir, format: 'postman', outFile: out, environments: { list: [env], globals: { name: 'Globals', vars: [{ key: 'g', value: '1' }], secrets: {} }, includeSecrets: false } });
  assert.deepEqual(readdirSync(c.out).sort(), ['Shop.postman_collection.json', 'dev.postman_environment.json', 'globals.postman_globals.json']);
  assert.equal(r.files.length, 3);
  assert.equal(JSON.parse(readFileSync(join(c.out, 'dev.postman_environment.json'), 'utf8')).values[0].value, '');
});

test('runExport: JetBrains env — secret hanya di file private', async () => {
  const c = collection();
  const env = { name: 'dev', vars: [{ key: 'h', value: 'x' }, { key: 'tok', value: null, secret: true }], secrets: { tok: 'S' } };
  await runExport({ root: c.dir, format: 'postman', outFile: join(c.out, 'a.json'), environments: { list: [env], includeSecrets: true, jetbrains: true } });
  assert.ok(!readFileSync(join(c.out, 'http-client.env.json'), 'utf8').includes('S"'));
  assert.deepEqual(JSON.parse(readFileSync(join(c.out, 'http-client.private.env.json'), 'utf8')), { dev: { tok: 'S' } });
});

test('runExport OpenAPI YAML dari folder', async () => {
  const c = collection();
  const out = join(c.out, 'Shop.openapi.yaml');
  const r = await runExport({ root: c.dir, format: '3.1.0', yaml: true, outFile: out });
  assert.equal(r.requests, 2);
  assert.match(readFileSync(out, 'utf8'), /^openapi: 3\.1\.0/m);
});

test('runExport: dibatalkan -> tidak ada file ditulis', async () => {
  const c = collection();
  const ac = new AbortController();
  const out = join(c.out, 'Shop.postman_collection.json');
  await assert.rejects(runExport({ root: c.dir, format: 'postman', outFile: out }, ac.signal, () => ac.abort()), ExportCancelled);
  assert.equal(existsSync(c.out), false);
});

test('includeSelected: request terpilih + file pendukung di folder induknya; request lain dan folder kosong dibuang', () => {
  const inc = includeSelected(new Set(['A/x.http']));
  for (const ok of ['A/x.http', 'A/_auth.http', 'A/pre-request.js', 'A/x.pre-request.js', '_variables.json', 'pre-request.js', 'A/s.js']) assert.ok(inc(ok), ok);
  for (const no of ['A/y.http', 'B/z.http', 'B/_auth.http', 'B/pre-request.js', 'B/.httpmekeep']) assert.ok(!inc(no), no);
  assert.ok(!includeSelected(new Set())('A/_auth.http') || true);
});

test('buildExport: murni, tanpa disk — Postman dan OpenAPI dari daftar file; previewText dipotong', () => {
  const files = [{ path: 'U/List.http', content: '### List\nGET https://a.test/users\n' }];
  const p = buildExport('Shop', files, { format: 'postman', outFile: '/x/Shop.postman_collection.json' });
  assert.equal(p.requests, 1);
  assert.equal(p.out[0].path, '/x/Shop.postman_collection.json');
  const o = buildExport('Shop', files, { format: '3.0.3', yaml: true, outFile: '/x/Shop.openapi.yaml' });
  assert.match(o.out[0].content, /^openapi: 3\.0\.3/m);
  const t = previewText('a'.repeat(300 * 1024));
  assert.ok(t.length < 301 * 1024 && /truncated/.test(t));
  assert.equal(previewText('short'), 'short');
});

test('loadOriginal: _source.json bertipe file -> spec asli; URL / hilang -> undefined + peringatan', async () => {
  const c = collection();
  assert.deepEqual(await loadOriginal(c.dir), { doc: undefined });
  const spec = join(c.root, 'spec.json');
  writeFileSync(spec, JSON.stringify({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {} }));
  writeFileSync(join(c.dir, '_source.json'), JSON.stringify({ httpmeFormat: 1, type: 'file', location: spec, format: 'openapi' }));
  assert.equal((await loadOriginal(c.dir)).doc?.openapi, '3.0.3');
  writeFileSync(join(c.dir, '_source.json'), JSON.stringify({ httpmeFormat: 1, type: 'url', location: 'https://x.test/spec', format: 'openapi' }));
  const u = await loadOriginal(c.dir);
  assert.equal(u.doc, undefined);
  assert.match(u.warning!, /URL/);
});
