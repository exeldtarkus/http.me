import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEW_REQUEST_TEXT, newRequestName } from '../../src/newRequest';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));

test('newRequestName: nomor pertama yang belum dipakai tab untitled lain', () => {
  assert.equal(newRequestName([]), 'New Request 1.http');
  assert.equal(newRequestName(['New Request 1.http', 'other.http', 'New Request 3.http']), 'New Request 2.http');
});

test('NEW_REQUEST_TEXT: request GET kosong format .http', () => {
  assert.match(NEW_REQUEST_TEXT, /^GET https:\/\/\n$/);
});

test('custom editor httpme.request untuk *.http, priority option (default tetap editor teks)', () => {
  const ed = pkg.contributes?.customEditors?.find((e: { viewType: string }) => e.viewType === 'httpme.request');
  assert.ok(ed, 'customEditors httpme.request belum ada');
  assert.equal(ed.priority, 'option');
  assert.deepEqual(ed.selector, [{ filenamePattern: '*.http' }]);
});

test('command http.me: New Request terdaftar', () => {
  const cmd = pkg.contributes?.commands?.find((c: { command: string }) => c.command === 'httpme.newRequest');
  assert.deepEqual(cmd && { title: cmd.title, category: cmd.category }, { title: 'New Request', category: 'http.me' });
});
