import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { fromJetBrainsEnv } from '../../src/jetbrainsEnv';
import { fromPostmanEnvironment } from '../../src/environments';

const pub = JSON.stringify({ dev: { host: 'http://localhost', port: 8080, debug: true, nested: { a: 1 } }, prod: { host: 'https://api.test' } });
const priv = JSON.stringify({ dev: { token: 'abc' }, prod: { token: 'xyz', host: 'https://override.test' } });

test('fromJetBrainsEnv: satu Environment per nama, key digabung dengan NULL', () => {
  const r = fromJetBrainsEnv(pub);
  assert.deepEqual(r.map((e) => e.name), ['dev', 'prod']);
  const prod = r[1].vars;
  assert.deepEqual(prod.map((v) => v.key), ['host', 'port', 'debug', 'nested']);
  assert.deepEqual(prod.find((v) => v.key === 'host'), { key: 'host', value: 'https://api.test' });
  assert.deepEqual(prod.find((v) => v.key === 'port'), { key: 'port', value: null });
  assert.equal(r[0].vars.find((v) => v.key === 'port')?.value, '8080');
  assert.equal(r[0].vars.find((v) => v.key === 'debug')?.value, 'true');
  assert.equal(r[0].vars.find((v) => v.key === 'nested')?.value, '{"a":1}');
});

test('fromJetBrainsEnv: nilai private -> Secret (nilai ke secrets, bukan file), key private ikut digabung', () => {
  const r = fromJetBrainsEnv(pub, priv);
  const dev = r[0], prod = r[1];
  assert.deepEqual(dev.vars.find((v) => v.key === 'token'), { key: 'token', value: null, secret: true });
  assert.deepEqual(dev.secrets, { token: 'abc' });
  assert.deepEqual(prod.secrets, { token: 'xyz', host: 'https://override.test' });
  assert.deepEqual(prod.vars.find((v) => v.key === 'host'), { key: 'host', value: null, secret: true }, 'private menimpa public');
  assert.ok(!JSON.stringify(r.map((e) => e.vars)).includes('xyz'));
  assert.equal(dev.vars.find((v) => v.key === 'host')?.value, 'http://localhost');
});

test('fromJetBrainsEnv: private-only Environment tetap dibuat; JSON rusak / bukan objek = error', () => {
  const r = fromJetBrainsEnv('{}', JSON.stringify({ qa: { k: 'v' } }));
  assert.deepEqual(r.map((e) => e.name), ['qa']);
  assert.throws(() => fromJetBrainsEnv('{bad'), /http-client\.env\.json/);
  assert.throws(() => fromJetBrainsEnv('[1]'), /expected an object/);
});

test('fromPostmanEnvironment: file Globals memakai format yang sama', () => {
  const g = fromPostmanEnvironment(JSON.stringify({ name: 'Globals', _postman_variable_scope: 'globals', values: [{ key: 'a', value: '1', enabled: true }, { key: 's', value: 'x', type: 'secret' }] }));
  assert.deepEqual(g.vars, [{ key: 'a', value: '1' }, { key: 's', value: null, secret: true }]);
  assert.deepEqual(g.secrets, { s: 'x' });
});
