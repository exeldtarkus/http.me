import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { join } from 'node:path';

type Param = { key: string; value: string; enabled: boolean };
// panel.js = JS vanilla webview; fungsi murninya diekspor lewat module.exports saat di-require di Node
const panel = require(join(__dirname, '..', '..', '..', 'media', 'webview', 'panel.js')) as {
  urlToParams(url: string): Param[];
  paramsToUrl(url: string, params: Param[]): string;
};

test('urlToParams: query URL jadi baris Params (nilai mentah, {{var}} utuh)', () => {
  assert.deepEqual(panel.urlToParams('https://a.test/p?x=1&user={{username}}&flag&e=a%20b#top'), [
    { key: 'x', value: '1', enabled: true },
    { key: 'user', value: '{{username}}', enabled: true },
    { key: 'flag', value: '', enabled: true },
    { key: 'e', value: 'a%20b', enabled: true },
  ]);
  assert.deepEqual(panel.urlToParams('https://a.test/p'), []);
  assert.deepEqual(panel.urlToParams('{{baseUrl}}/p?q=a=b'), [{ key: 'q', value: 'a=b', enabled: true }]);
});

test('paramsToUrl: Params aktif ditulis ulang ke URL, fragment & base tetap; nonaktif tidak masuk URL', () => {
  const params: Param[] = [
    { key: 'x', value: '2', enabled: true },
    { key: 'debug', value: 'true', enabled: false },
    { key: 'flag', value: '', enabled: true },
    { key: '', value: '', enabled: true },
  ];
  assert.equal(panel.paramsToUrl('https://a.test/p?old=1#top', params), 'https://a.test/p?x=2&flag#top');
  assert.equal(panel.paramsToUrl('https://a.test/p?old=1', []), 'https://a.test/p');
  assert.equal(panel.paramsToUrl('{{baseUrl}}/p', [{ key: 'q', value: '{{v}}', enabled: true }]), '{{baseUrl}}/p?q={{v}}');
});

test('URL ↔ Params bolak-balik tanpa perubahan', () => {
  for (const url of ['https://a.test/p?x=1&y=2', 'https://a.test/?a&b', '{{base}}/x?q={{q}}#f']) {
    assert.equal(panel.paramsToUrl(url, panel.urlToParams(url)), url);
  }
});
