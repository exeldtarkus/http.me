import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

// scripts/ ada di luar rootDir TS: di-require lewat path runtime dari repo root
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseProfile, profileArgs } = require(path.join(__dirname, '../../../scripts/install-local-profile.js'));

test('profileArgs: tanpa profile = tidak ada argumen (profile Default)', () => {
  assert.deepEqual(profileArgs(undefined), []);
  assert.deepEqual(profileArgs(''), []);
});

test('profileArgs: nama profile diteruskan sebagai --profile', () => {
  assert.deepEqual(profileArgs('http'), ['--profile', 'http']);
});

test('parseProfile: --profile <nama>, --profile=<nama>, lalu env, lalu kosong', () => {
  assert.equal(parseProfile(['--force', '--profile', 'http'], {}), 'http');
  assert.equal(parseProfile(['--profile=http'], {}), 'http');
  assert.equal(parseProfile(['--force'], { HTTPME_PROFILE: 'dev' }), 'dev');
  assert.equal(parseProfile(['--profile', 'a'], { HTTPME_PROFILE: 'b' }), 'a');
  assert.equal(parseProfile([], {}), undefined);
});
