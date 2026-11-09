import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan } from '../../src/importer';
import { importOpenApi } from '../../src/openapi';
import { importPostman } from '../../src/postman';
import { parseAuth } from '../../src/auth';
import { parseDoc, type ImportPlan } from '../../src/importCommon';
import { parseRequest, splitBlocks } from '../../src/httpFile';
import { parseEnvironment } from '../../src/environments';

const fx = (n: string) => readFileSync(join(__dirname, '../../../test/fixtures/import', n), 'utf8');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

/** tulis ke disk lalu baca balik: setiap .http bisa di-parse, auth valid, tidak ada {{ }} rusak, variabel JSON valid */
async function roundtrip(plan: ImportPlan): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'httpme-e2e-'));
  try {
    const res = await applyPlan(plan, { dir });
    assert.deepEqual(res.failed, []);
    assert.equal(res.created.length, plan.files.length);
    const files = walk(dir);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (f.endsWith('.http')) {
        assert.equal(splitBlocks(text).length <= 1, true, `${f}: satu request per file`);
        const r = parseRequest(text);
        assert.doesNotThrow(() => parseAuth(r.auth, r.headers), `${f}: auth valid`);
        if (!f.endsWith('_auth.http')) assert.match(r.url, /^(\{\{[^}]+\}\}|https?:\/\/)/, `${f}: URL ${r.url}`);
        assert.ok(r.method, f);
      } else if (f.endsWith('.json')) assert.doesNotThrow(() => parseEnvironment(text, f));
    }
    return files.map((f) => f.slice(dir.length + 1));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('e2e Postman: tulis ke disk, baca balik semua valid', async () => {
  const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
  const plan = importPostman({
    info: { name: 'E2E', schema: SCHEMA }, variable: [{ key: 'baseUrl', value: 'https://x.test' }],
    auth: { type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'accessTokenUrl', value: 'https://x.test/t' }, { key: 'clientId', value: 'c' }, { key: 'clientSecret', value: 's' }] },
    item: [{ name: 'F', item: [
      { name: 'a', request: { method: 'POST', url: '{{baseUrl}}/a', auth: { type: 'bearer', bearer: [{ key: 'token', value: '' }] }, body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } } }, event: [{ listen: 'test', script: { exec: ['pm.test("t", () => pm.expect(1).to.eql(1));'] } }] },
      { name: 'b', request: { method: 'GET', url: { raw: '{{baseUrl}}/b?x=1', host: ['{{baseUrl}}'], path: ['b'], query: [{ key: 'x', value: '1' }, { key: 'y', value: '2', disabled: true }] } } },
    ] }],
  });
  const files = await roundtrip(plan);
  assert.ok(files.includes('E2E/F/a.post-request.js') && files.includes('E2E/_variables.json') && files.includes('E2E/_auth.http'));
});

for (const [name, file] of [['Swagger 2.0 JSON', 'petstore2.json'], ['OpenAPI 3.0 YAML', 'petstore3.yaml']] as const) {
  test(`e2e ${name}: tulis ke disk, baca balik semua valid, import ulang = tidak ada perubahan`, async () => {
    const plan = importOpenApi(parseDoc(fx(file)));
    const files = await roundtrip(plan);
    assert.ok(files.filter((f) => f.endsWith('.http') && !f.endsWith('_auth.http')).length >= 4);
    const again = importOpenApi(parseDoc(fx(file)));
    assert.deepEqual(again.files.map((f) => [f.path, f.content]), plan.files.map((f) => [f.path, f.content]), 'deterministik');
  });
}
