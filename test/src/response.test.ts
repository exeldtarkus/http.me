import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatSize, formatTime, highlightJson, prettyJson, responseView, statusClass } from '../../src/response';
import type { HttpResponse } from '../../src/http';

const res = (p: Partial<HttpResponse>): HttpResponse => ({
  status: 200, statusText: 'OK', headers: [], body: Buffer.alloc(0), size: 0, timeMs: 1, url: 'http://x', ...p,
});

test('statusClass: warna per kelas 1xx–5xx', () => {
  assert.deepEqual([101, 200, 204, 302, 404, 500, 599, 0].map(statusClass), ['st-1', 'st-2', 'st-2', 'st-3', 'st-4', 'st-5', 'st-5', 'st-5']);
});

test('formatSize / formatTime', () => {
  assert.deepEqual([0, 412, 1024, 1536, 1048576, 3.5 * 1048576].map(formatSize), ['0 B', '412 B', '1.0 KB', '1.5 KB', '1.0 MB', '3.5 MB']);
  assert.deepEqual([0, 184, 999, 1000, 1250, 61000].map(formatTime), ['0 ms', '184 ms', '999 ms', '1.00 s', '1.25 s', '61.00 s']);
});

test('prettyJson: JSON valid dirapikan 2 spasi, tidak valid = undefined', () => {
  assert.equal(prettyJson('{"a":[1,{"b":null}]}'), '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ]\n}');
  assert.equal(prettyJson('{oops'), undefined);
  assert.equal(prettyJson(''), undefined);
});

test('highlightJson: key / string / number / literal diberi warna, teks di-escape', () => {
  const html = highlightJson('{\n  "a<b>": "x & \\"y\\"",\n  "n": -1.5e3,\n  "t": true,\n  "z": null\n}');
  assert.match(html, /<span class="k">&quot;a&lt;b&gt;&quot;<\/span>/);
  assert.match(html, /<span class="s">&quot;x &amp; \\&quot;y\\&quot;&quot;<\/span>/);
  assert.match(html, /<span class="n">-1\.5e3<\/span>/);
  assert.match(html, /<span class="n">true<\/span>/);
  assert.match(html, /<span class="n">null<\/span>/);
  assert.doesNotMatch(html, /<b>/);
});

test('responseView: JSON pretty + warna, teks biasa di-escape, header & meta', () => {
  const v = responseView(res({ status: 201, statusText: 'Created', headers: [['content-type', 'application/json']], body: Buffer.from('{"a":1}'), size: 7, timeMs: 184 }), 'POST');
  assert.equal(v.status, '201 Created');
  assert.equal(v.statusClass, 'st-2');
  assert.equal(v.time, '184 ms');
  assert.equal(v.size, '7 B');
  assert.equal(v.bodyHtml, '{\n  <span class="k">&quot;a&quot;</span>: <span class="n">1</span>\n}');
  assert.deepEqual(v.headers, [['content-type', 'application/json']]);
  const t = responseView(res({ headers: [['content-type', 'text/html']], body: Buffer.from('<p>hi</p>') }), 'GET');
  assert.equal(t.bodyHtml, '&lt;p&gt;hi&lt;/p&gt;');
  const bad = responseView(res({ headers: [['content-type', 'application/json']], body: Buffer.from('{bad') }), 'GET');
  assert.equal(bad.bodyHtml, '{bad', 'JSON rusak tampil apa adanya');
});

test('responseView: HEAD = tanpa body, OPTIONS = daftar method menonjol', () => {
  assert.equal(responseView(res({}), 'HEAD').head, true);
  assert.equal(responseView(res({}), 'GET').head, false);
  assert.deepEqual(responseView(res({ headers: [['allow', 'GET, POST']] }), 'OPTIONS').allow, ['GET', 'POST']);
  assert.equal(responseView(res({ headers: [['allow', 'GET']] }), 'GET').allow, undefined);
});
