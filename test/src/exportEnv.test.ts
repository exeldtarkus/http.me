import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { fromJetBrainsEnv, toJetBrainsEnv } from '../../src/jetbrainsEnv';

const envs = [
  { name: 'dev', vars: [{ key: 'host', value: 'dev.test' }, { key: 'token', value: null, secret: true }], secrets: { token: 'SECRET1' } },
  { name: 'prod', vars: [{ key: 'host', value: 'prod.test' }, { key: 'token', value: null, secret: true }], secrets: { token: 'SECRET2' } },
];

test('export JetBrains: secret tidak pernah masuk file utama', () => {
  const r = toJetBrainsEnv(envs, { includeSecrets: true });
  assert.deepEqual(JSON.parse(r.publicJson), { dev: { host: 'dev.test' }, prod: { host: 'prod.test' } });
  assert.deepEqual(JSON.parse(r.privateJson!), { dev: { token: 'SECRET1' }, prod: { token: 'SECRET2' } });
  assert.ok(!r.publicJson.includes('SECRET'));
});

test('export JetBrains: tanpa includeSecrets tidak ada file private', () => {
  const r = toJetBrainsEnv(envs, { includeSecrets: false });
  assert.equal(r.privateJson, undefined);
  assert.ok(!r.publicJson.includes('SECRET'));
});

test('export JetBrains: round-trip import <-> export', () => {
  const r = toJetBrainsEnv(envs, { includeSecrets: true });
  const back = fromJetBrainsEnv(r.publicJson, r.privateJson);
  assert.deepEqual(back.map((e) => ({ name: e.name, vars: e.vars, secrets: e.secrets })).sort((a, b) => a.name.localeCompare(b.name)),
    envs.map((e) => ({ name: e.name, vars: e.vars, secrets: e.secrets })).sort((a, b) => a.name.localeCompare(b.name)));
});
