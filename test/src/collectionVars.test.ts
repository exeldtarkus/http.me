import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectionScope } from '../../src/collectionVars';
import { substitute, type Scope } from '../../src/vars';

const env: Scope = { source: 'environment', name: 'dev', values: new Map([['host', 'env-host'], ['nul', null]]) };
const globals: Scope = { source: 'globals', values: new Map([['host', 'glob-host'], ['g', 'G'], ['nul', 'glob-nul']]) };
const mk = (values: [string, string | null][]): Scope => ({ source: 'collection', values: new Map(values) });

test('urutan resolusi: Environment aktif -> collection -> Globals', () => {
  const col = mk([['host', 'col-host'], ['c', 'C'], ['g', 'col-g']]);
  const s = substitute('{{host}} {{c}} {{g}} {{nul}}', [env, col, globals]);
  assert.equal(s.text, 'env-host C col-g glob-nul', 'NULL di Environment lanjut ke scope berikutnya');
  assert.equal(substitute('{{host}}', [{ ...env, values: new Map() }, col, globals]).text, 'col-host');
});

test('collectionScope: _variables.json terdekat naik ke root; secret & nonaktif dilewati', async () => {
  const root = mkdtempSync(join(tmpdir(), 'httpme-col-'));
  try {
    mkdirSync(join(root, 'api', 'users'), { recursive: true });
    writeFileSync(join(root, 'api', '_variables.json'), JSON.stringify({ httpmeFormat: 1, variables: [{ key: 'a', value: '1' }, { key: 's', secret: true }, { key: 'off', value: 'x', enabled: false }] }));
    const s = await collectionScope(root, join(root, 'api', 'users', 'list.http'));
    assert.deepEqual([...s!.values], [['a', '1']]);
    assert.equal(s!.source, 'collection');
    assert.equal(await collectionScope(root, join(root, 'other.http')), undefined);
    writeFileSync(join(root, 'api', '_variables.json'), '{bad');
    await assert.rejects(collectionScope(root, join(root, 'api', 'x.http')), /_variables\.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
