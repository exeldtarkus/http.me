import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { HTTPME_FORMAT, parseFormatted, stringifyFormatted } from '../../src/format';

test('stringifyFormatted: "httpmeFormat": 1 ditulis paling atas, JSON rapi + newline', () => {
  const s = stringifyFormatted({ name: 'dev', values: [] });
  assert.equal(HTTPME_FORMAT, 1);
  assert.ok(s.startsWith('{\n  "httpmeFormat": 1,\n  "name": "dev"'), s);
  assert.ok(s.endsWith('}\n'));
  assert.deepEqual(parseFormatted(s, 'dev.json'), { httpmeFormat: 1, name: 'dev', values: [] });
});

test('parseFormatted: format sama / tanpa field (file lama / buatan tangan) diterima', () => {
  assert.deepEqual(parseFormatted('{"httpmeFormat":1,"a":1}', 'x.json'), { httpmeFormat: 1, a: 1 });
  assert.deepEqual(parseFormatted('{"a":1}', 'x.json'), { a: 1 });
});

test('parseFormatted: format lebih baru ditolak dengan pesan "Update http.me"', () => {
  assert.throws(() => parseFormatted('{"httpmeFormat":2}', '.httpme/environments/dev.json'),
    /dev\.json was saved by a newer version of http\.me \(format 2\)\. Update http\.me to open it\./);
});

test('parseFormatted: httpmeFormat bukan angka bulat positif / bukan objek = error yang jelas', () => {
  for (const bad of ['{"httpmeFormat":"1"}', '{"httpmeFormat":0}', '{"httpmeFormat":1.5}']) {
    assert.throws(() => parseFormatted(bad, 'x.json'), /x\.json: invalid "httpmeFormat"/, bad);
  }
  assert.throws(() => parseFormatted('[1]', 'x.json'), /x\.json: expected a JSON object/);
  assert.throws(() => parseFormatted('{oops', 'x.json'), /x\.json: invalid JSON/);
});
