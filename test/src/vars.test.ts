import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DYNAMIC_NAMES, dynamicValue, fileScope, lookup, resolveRequest, substitute, type Scope } from '../../src/vars';
import { emptyRequest } from '../../src/httpFile';

const scope = (source: Scope['source'], o: Record<string, string | null>, name?: string): Scope => ({ source, name, values: new Map(Object.entries(o)) });
const dyn = { now: () => Date.UTC(2026, 10, 4, 1, 2, 3), random: () => 0.5, uuid: () => '11111111-2222-4333-8444-555555555555' };

test('lookup: prioritas script → file → Environment aktif → collection → Globals', () => {
  const scopes = [
    scope('script', { a: 's' }), scope('file', { a: 'f', b: 'f' }), scope('environment', { a: 'e', b: 'e', c: 'e' }, 'uat'),
    scope('collection', { d: 'c' }), scope('globals', { c: 'g', d: 'g', e: 'g' }),
  ];
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((n) => { const r = lookup(n, scopes); return r.found ? `${r.value}@${r.scope.source}` : '-'; }), ['s@script', 'f@file', 'e@environment', 'c@collection', 'g@globals']);
});

test('lookup: NULL di Environment aktif dicari di Globals; "" adalah nilai, bukan NULL', () => {
  const env = scope('environment', { apiKey: null, empty: '', only: null }, 'uat');
  const globals = scope('globals', { apiKey: 'g-key', empty: 'g' });
  assert.deepEqual(lookup('apiKey', [env, globals]), { found: true, value: 'g-key', scope: globals });
  assert.deepEqual(lookup('empty', [env, globals]), { found: true, value: '', scope: env });
  assert.deepEqual(lookup('only', [env, globals]), { found: false, nullIn: [env] });
  assert.deepEqual(lookup('nope', [env, globals]), { found: false, nullIn: [] });
});

test('substitute: {{ var }} dengan spasi, nilai bersarang, NULL & tidak ada dibiarkan + dilaporkan', () => {
  const scopes = [scope('file', { api: '{{base}}/v1' }), scope('environment', { base: 'https://a.test', k: null }, 'dev')];
  assert.deepEqual(substitute('{{api}}/x?k={{ k }}&m={{missing}}&k2={{k}}', scopes), {
    text: 'https://a.test/v1/x?k={{ k }}&m={{missing}}&k2={{k}}', nulls: ['k'], missing: ['missing'],
  });
  // rujukan melingkar berhenti (tidak hang)
  const loop = [scope('file', { a: '{{b}}', b: '{{a}}' })];
  assert.equal(typeof substitute('{{a}}', loop).text, 'string');
});

test('variable dinamis: $timestamp, $isoTimestamp, $guid/$uuid, $randomInt (0–1000 / min max), $datetime iso8601', () => {
  assert.equal(dynamicValue('$timestamp', dyn), String(Math.floor(dyn.now() / 1000)));
  assert.equal(dynamicValue('$isoTimestamp', dyn), '2026-11-04T01:02:03.000Z');
  assert.equal(dynamicValue('$datetime iso8601', dyn), '2026-11-04T01:02:03.000Z');
  assert.equal(dynamicValue('$datetime rfc1123', dyn), 'Wed, 04 Nov 2026 01:02:03 GMT');
  assert.equal(dynamicValue('$guid', dyn), '11111111-2222-4333-8444-555555555555');
  assert.equal(dynamicValue('$uuid', dyn), dynamicValue('$guid', dyn));
  assert.equal(dynamicValue('$randomInt', dyn), '500');
  assert.equal(dynamicValue('$randomInt 10 20', dyn), '15');
  assert.equal(dynamicValue('$nope', dyn), undefined);
  assert.equal(dynamicValue('$randomInt x', dyn), undefined);
  assert.deepEqual(substitute('{{$guid}} {{$nope}}', [], dyn), { text: '11111111-2222-4333-8444-555555555555 {{$nope}}', nulls: [], missing: ['$nope'] });
  assert.ok(DYNAMIC_NAMES.includes('$randomInt'));
});

test('resolveRequest: URL, header aktif, body; variabel file @var; request asli tidak diubah', () => {
  const r = emptyRequest();
  r.vars = [{ name: 'path', value: 'users' }];
  r.url = '{{base}}/{{path}}';
  r.headers = [{ name: 'X-{{h}}', value: '{{token}}', enabled: true }, { name: 'Off', value: '{{gone}}', enabled: false }];
  r.body = '{"k":"{{token}}"}';
  const scopes = [fileScope(r.vars), scope('environment', { base: 'https://a', h: 'Id', token: null }, 'dev')];
  const out = resolveRequest(r, scopes, dyn);
  assert.equal(out.request.url, 'https://a/users');
  assert.deepEqual(out.request.headers[0], { name: 'X-Id', value: '{{token}}', enabled: true });
  assert.equal(out.request.headers[1].value, '{{gone}}', 'header nonaktif tidak diselesaikan');
  assert.deepEqual([out.nulls, out.missing], [['token'], []]);
  assert.equal(r.url, '{{base}}/{{path}}');
});
