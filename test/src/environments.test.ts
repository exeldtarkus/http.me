import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearedKey, createEnvironment, deleteEnvironment, duplicateEnvironment, environmentValues, fromPostmanEnvironment, keyMismatch, listEnvironments,
  mismatchMessage, parseEnvironment, persistAll, readEnvironment, renameEnvironment, renamedKey, serializeEnvironment, syncKeys, updateAll,
  validateVars, withKey, withoutKey, withSecret, writeEnvironment, type EnvVar,
} from '../../src/environments';
import { environmentFileName } from '../../src/store';
import { withTempDir } from './helpers/tmp';

const v = (key: string, value: string | null, o: Partial<EnvVar> = {}): EnvVar => ({ key, value, ...o });

test('parse / serialize: httpmeFormat 1, value null tetap null, secret tanpa nilai di file, enabled default true', () => {
  const vars = [v('baseUrl', 'https://a'), v('apiKey', 'should-not-be-written', { secret: true }), v('off', '', { enabled: false }), v('n', null)];
  const text = serializeEnvironment(vars);
  const json = JSON.parse(text);
  assert.equal(json.httpmeFormat, 1);
  assert.deepEqual(json.variables[1], { key: 'apiKey', secret: true });
  assert.deepEqual(json.variables[3], { key: 'n', value: null });
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(parseEnvironment(text), [v('baseUrl', 'https://a'), v('apiKey', null, { secret: true }), v('off', '', { enabled: false }), v('n', null)]);
  assert.throws(() => parseEnvironment('{ nope'), /invalid JSON/);
  assert.throws(() => parseEnvironment('{"variables": 1}'), /variables/);
  assert.deepEqual(parseEnvironment('{"variables":[{"key":"x","value":5}]}'), [v('x', '5')], 'angka dari edit manual jadi teks');
});

test('validateVars: nama kosong & duplikat ditandai per baris', () => {
  assert.deepEqual(validateVars([v('a', '1'), v(' ', '2'), v('a', '3'), v('b', null)]), [
    { index: 1, message: 'Variable name is required' },
    { index: 2, message: 'Duplicate variable "a"' },
  ]);
  assert.deepEqual(validateVars([v('a', '1')]), []);
});

test('environmentValues: current value menimpa initial, secret dari SecretStorage (tanpa = NULL), nonaktif dilewati', () => {
  const vars = [v('a', 'init'), v('b', 'init'), v('s', null, { secret: true }), v('t', null, { secret: true }), v('off', 'x', { enabled: false }), v('n', null)];
  const m = environmentValues(vars, { a: 'cur', n: 'filled' }, { s: 'shh' });
  assert.deepEqual([...m], [['a', 'cur'], ['b', 'init'], ['s', 'shh'], ['t', null], ['n', 'filled']]);
});

test('persistAll: current -> initial (secret tidak ikut); Reset = current kosong', () => {
  assert.deepEqual(persistAll([v('a', '1'), v('s', null, { secret: true }), v('n', null)], { a: '2', s: 'x', n: '' }), [v('a', '2'), v('s', null, { secret: true }), v('n', '')]);
});

test('operasi key murni: tambah (NULL), rename, hapus, clear, secret', () => {
  const vars = [v('a', '1'), v('b', '2')];
  assert.deepEqual(withKey(vars, 'c'), [...vars, v('c', null)]);
  assert.deepEqual(withKey(vars, 'a'), vars, 'sudah ada: tidak berubah');
  assert.deepEqual(withKey(vars, 's', true), [...vars, v('s', null, { secret: true })]);
  assert.deepEqual(renamedKey(vars, 'a', 'z'), [v('z', '1'), v('b', '2')]);
  assert.deepEqual(withoutKey(vars, 'a'), [v('b', '2')]);
  assert.deepEqual(clearedKey(vars, 'b'), [v('a', '1'), v('b', null)]);
  assert.deepEqual(withSecret(vars, 'a', true), [v('a', null, { secret: true }), v('b', '2')], 'jadi secret: nilai keluar dari file');
});

test('Key sama di semua Environment: tambah / rename / hapus ke semua file, environment baru = semua key NULL', async () => {
  await withTempDir(async (dir) => {
    await writeEnvironment(dir, 'dev', [v('baseUrl', 'http://dev'), v('token', 'd', { secret: true })]);
    await writeEnvironment(dir, 'uat', [v('baseUrl', 'http://uat'), v('token', null, { secret: true })]);
    assert.deepEqual(await listEnvironments(dir), ['dev', 'uat']);

    assert.deepEqual(await updateAll(dir, (x) => withKey(x, 'apiKey'), 'uat'), ['dev'], 'uat (yang diedit) dilewati');
    assert.deepEqual((await readEnvironment(dir, 'dev')).map((x) => x.key), ['baseUrl', 'token', 'apiKey']);
    assert.equal((await readEnvironment(dir, 'dev'))[2].value, null);

    await updateAll(dir, (x) => renamedKey(x, 'baseUrl', 'host'));
    assert.deepEqual((await readEnvironment(dir, 'uat')).map((x) => x.key), ['host', 'token']);
    await updateAll(dir, (x) => withoutKey(x, 'token'));
    assert.ok(!readFileSync(join(dir, 'dev.json'), 'utf8').includes('token'));

    await createEnvironment(dir, 'prod');
    assert.deepEqual(await readEnvironment(dir, 'prod'), [v('host', null), v('apiKey', null)]);
    await assert.rejects(createEnvironment(dir, 'prod'), /already exists/);
    await assert.rejects(createEnvironment(dir, 'a/b'), /must not contain/);

    await duplicateEnvironment(dir, 'dev', 'dev2');
    assert.deepEqual(await readEnvironment(dir, 'dev2'), await readEnvironment(dir, 'dev'));
    await renameEnvironment(dir, 'dev2', 'local');
    assert.ok(existsSync(join(dir, 'local.json')) && !existsSync(join(dir, 'dev2.json')));
    await deleteEnvironment(dir, 'local');
    assert.deepEqual(await listEnvironments(dir), ['dev', 'prod', 'uat']);
  });
});

test('readEnvironment: cache 30 dtk, writeEnvironment memperbarui cache; folder belum ada = daftar kosong', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await listEnvironments(join(dir, 'none')), []);
    mkdirSync(dir, { recursive: true });
    await writeEnvironment(dir, 'dev', [v('a', '1')]);
    await readEnvironment(dir, 'dev');
    writeFileSync(join(dir, 'dev.json'), serializeEnvironment([v('a', 'outside')]));
    assert.equal((await readEnvironment(dir, 'dev'))[0].value, '1', 'masih dari cache');
    assert.equal((await readEnvironment(dir, 'dev', true))[0].value, 'outside', 'fresh = baca ulang (watcher)');
  });
});

test('keyMismatch / syncKeys / pesan: key tidak sama dari luar (git pull)', () => {
  const envs = [{ name: 'dev', vars: [v('a', '1'), v('b', '2'), v('s', 'x', { secret: true })] }, { name: 'prod', vars: [v('a', '1')] }, { name: 'uat', vars: [v('a', '1'), v('b', '1'), v('s', null, { secret: true })] }];
  const miss = keyMismatch(envs);
  assert.deepEqual(miss, [{ name: 'prod', missing: ['b', 's'] }]);
  assert.equal(mismatchMessage(miss), '2 keys missing in Environment "prod"');
  assert.equal(mismatchMessage([{ name: 'a', missing: ['x'] }, { name: 'b', missing: ['x', 'y'] }]), '1 key missing in Environment "a", 2 keys missing in Environment "b"');
  assert.deepEqual(syncKeys(envs[1].vars, envs), [v('a', '1'), v('b', null), v('s', null, { secret: true })], 'flag secret ikut');
  assert.deepEqual(keyMismatch([envs[0], { name: 'x', vars: [v('a', null), v('b', null), v('s', null, { secret: true })] }]), []);
});

test('fromPostmanEnvironment: nama, values, secret ke SecretStorage, disabled; bukan environment Postman = error', () => {
  const r = fromPostmanEnvironment(JSON.stringify({
    name: 'Staging', _postman_variable_scope: 'environment',
    values: [{ key: 'base', value: 'https://s', enabled: true }, { key: 'pw', value: 'p', type: 'secret', enabled: true }, { key: 'off', value: '1', enabled: false }],
  }));
  assert.equal(r.name, 'Staging');
  assert.deepEqual(r.vars, [v('base', 'https://s'), v('pw', null, { secret: true }), v('off', '1', { enabled: false })]);
  assert.deepEqual(r.secrets, { pw: 'p' });
  assert.throws(() => fromPostmanEnvironment('{"info":{}}'), /not a Postman environment/);
});

test('environmentFileName: .json otomatis, karakter ilegal / path ditolak', () => {
  assert.equal(environmentFileName(' uat '), 'uat.json');
  assert.equal(environmentFileName('prod.json'), 'prod.json');
  for (const bad of ['', 'a/b', '..', 'x?']) assert.equal(typeof environmentFileName(bad), 'object', bad);
});
