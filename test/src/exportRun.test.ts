import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportCancelled, runExport } from '../../src/exportRun';

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
