import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_KEEP, BACKUP_MAX_BYTES, backupFileName, fingerprint, importHistoryItems, parseBackup, shouldBackup, writeBackup } from '../../src/backup';
import { addHistory, historyEntry, historyId, listHistory } from '../../src/history';
import { parseRequest } from '../../src/httpFile';
import { withTempDir } from './helpers/tmp';

const T = new Date(2026, 10, 9, 14, 30, 5).getTime();
const DAY = 24 * 3600 * 1000;

test('backupFileName: jenis + tanggal + jam lokal', () => {
  assert.equal(backupFileName('history', T), 'history-2026-11-09_143005.json');
  assert.equal(backupFileName('temp', T), 'temp-2026-11-09_143005.json');
});

test('shouldBackup: kosong tidak; pertama ya; tidak berubah tidak; hari baru ya; hari sama hanya bila tumbuh >= batas', () => {
  const cur = (key: string, size: number) => ({ key, size });
  assert.equal(shouldBackup(undefined, cur('a', 0), T), false, 'kosong tidak perlu backup');
  assert.equal(shouldBackup(undefined, cur('a', 10), T), true);
  assert.equal(shouldBackup({ at: T - DAY, key: 'a', size: 10 }, cur('a', 10), T), false, 'tidak berubah');
  assert.equal(shouldBackup({ at: T - DAY, key: 'a', size: 10 }, cur('b', 11), T), true, 'hari baru + berubah');
  assert.equal(shouldBackup({ at: T - 1000, key: 'a', size: 10 }, cur('b', 11), T), false, 'hari sama, tumbuh sedikit');
  assert.equal(shouldBackup({ at: T - 1000, key: 'a', size: 10 }, cur('b', 10 + BACKUP_MAX_BYTES), T), true, 'hari sama, tumbuh >= batas');
});

test('fingerprint: key sama untuk isi sama, size = byte JSON', () => {
  assert.equal(fingerprint([{ a: 1 }]).key, fingerprint([{ a: 1 }]).key);
  assert.notEqual(fingerprint([{ a: 1 }]).key, fingerprint([{ a: 2 }]).key);
  assert.equal(fingerprint([{ a: 1 }]).size, Buffer.byteLength('[{"a":1}]'));
});

test('writeBackup + parseBackup: round trip 0600, hanya BACKUP_KEEP file terbaru per jenis yang disimpan', () =>
  withTempDir(async (dir) => {
    for (let i = 0; i < BACKUP_KEEP + 2; i++) await writeBackup(dir, 'temp', [{ text: `GET http://x/${i}\n` }], T + i * 1000);
    const files = (await fs.readdir(dir)).sort();
    assert.equal(files.length, BACKUP_KEEP);
    assert.equal(files[0], backupFileName('temp', T + 2000), 'yang tertua dibuang');
    const last = join(dir, files.at(-1)!);
    assert.equal((await fs.stat(last)).mode & 0o777, 0o600);
    const b = parseBackup(await fs.readFile(last, 'utf8'));
    assert.equal(b.kind, 'temp');
    assert.deepEqual(b.items, [{ text: `GET http://x/${BACKUP_KEEP + 1}\n` }]);
  }));

test('parseBackup: format salah ditolak dengan pesan jelas', () => {
  assert.throws(() => parseBackup('bukan json'), /not a valid http\.me backup/i);
  assert.throws(() => parseBackup('{"httpmeFormat":1,"kind":"x","items":[]}'), /not a valid http\.me backup/i);
  assert.throws(() => parseBackup('{"httpmeFormat":2,"kind":"temp","items":[]}'), /not a valid http\.me backup/i);
});

test('importHistoryItems: entri baru ditambah, id yang sudah ada dilewati, entri rusak dihitung', () =>
  withTempDir(async (dir) => {
    const r = parseRequest('GET http://x/a\n');
    const old = historyEntry({ id: historyId(1000, 1), time: 1000, request: r, status: 200 });
    const fresh = historyEntry({ id: historyId(2000, 2), time: 2000, request: r, status: 404 });
    await addHistory(dir, old);
    const res = await importHistoryItems(dir, [old, fresh, { nope: true }]);
    assert.deepEqual(res, { added: 1, skipped: 1, invalid: 1 });
    assert.equal((await listHistory(dir)).length, 2);
  }));

test('importHistoryItems: onProgress dilaporkan per entri sampai total', () =>
  withTempDir(async (dir) => {
    const r = parseRequest('GET http://x/a\n');
    const items = [1, 2, 3].map((n) => historyEntry({ id: historyId(n * 1000, n), time: n * 1000, request: r, status: 200 }));
    const seen: [number, number][] = [];
    await importHistoryItems(dir, items, (done, total) => seen.push([done, total]));
    assert.deepEqual(seen, [[1, 3], [2, 3], [3, 3]]);
  }));
