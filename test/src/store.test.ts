import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { duplicateFile, movePath, renamePath, requestFileName, siblingName } from '../../src/store';
import { withTempDir } from './helpers/tmp';

test('requestFileName: .http otomatis, subfolder boleh, .. / kosong / karakter ilegal ditolak', () => {
  assert.equal(requestFileName('login'), 'login.http');
  assert.equal(requestFileName(' auth/login.HTTP '), 'auth/login.HTTP');
  assert.equal(requestFileName('\\auth\\x'), 'auth/x.http');
  for (const bad of ['', '  ', '../x', 'a/../b', 'a//b', 'a:b', 'what?', 'con<1>', 'a|b', 'tab\there']) {
    assert.equal(typeof requestFileName(bad), 'object', bad);
  }
  assert.deepEqual(requestFileName('../x'), { error: 'Invalid path: .. and empty folder names are not allowed' });
});

test('siblingName: tanpa / atau \\, file tetap .http, folder apa adanya', () => {
  assert.equal(siblingName('new', true), 'new.http');
  assert.equal(siblingName('api', false), 'api');
  assert.deepEqual(siblingName('a/b', true), { error: 'Name must not contain / or \\' });
  assert.deepEqual(siblingName('..', false), { error: 'Name must not contain / or \\' });
  assert.deepEqual(siblingName(' ', true), { error: 'Name is required' });
});

test('renamePath: di folder yang sama, nama bentrok ditolak', () => withTempDir(async (dir) => {
  writeFileSync(join(dir, 'a.http'), 'GET https://a\n');
  writeFileSync(join(dir, 'b.http'), '');
  assert.equal(await renamePath(join(dir, 'a.http'), 'c'), join(dir, 'c.http'));
  assert.equal(readFileSync(join(dir, 'c.http'), 'utf8'), 'GET https://a\n');
  await assert.rejects(renamePath(join(dir, 'c.http'), 'b.http'), /b\.http already exists/);
  mkdirSync(join(dir, 'f'));
  assert.equal(await renamePath(join(dir, 'f'), 'g', false), join(dir, 'g'));
}));

test('duplicateFile: "name copy.http", lalu "name copy 2.http"', () => withTempDir(async (dir) => {
  writeFileSync(join(dir, 'login.http'), 'GET https://a\n');
  assert.equal(await duplicateFile(join(dir, 'login.http')), join(dir, 'login copy.http'));
  assert.equal(await duplicateFile(join(dir, 'login.http')), join(dir, 'login copy 2.http'));
  assert.equal(readFileSync(join(dir, 'login copy 2.http'), 'utf8'), 'GET https://a\n');
}));

test('movePath: pindah file / folder; bentrok & folder ke dalam dirinya sendiri ditolak', () => withTempDir(async (dir) => {
  mkdirSync(join(dir, 'api/auth'), { recursive: true });
  mkdirSync(join(dir, 'other'));
  writeFileSync(join(dir, 'x.http'), '');
  assert.equal(await movePath(join(dir, 'x.http'), join(dir, 'api')), join(dir, 'api', 'x.http'));
  assert.equal(await movePath(join(dir, 'api', 'auth'), join(dir, 'other')), join(dir, 'other', 'auth'));
  assert.ok(existsSync(join(dir, 'other', 'auth')));
  writeFileSync(join(dir, 'x.http'), '');
  await assert.rejects(movePath(join(dir, 'x.http'), join(dir, 'api')), /x\.http already exists in api/);
  await assert.rejects(movePath(join(dir, 'other'), join(dir, 'other', 'auth')), /cannot be moved into itself/);
  assert.equal(await movePath(join(dir, 'api', 'x.http'), join(dir, 'api')), join(dir, 'api', 'x.http'), 'folder sama: tidak berubah');
}));
