import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { tabStatus, formatSize, formatTime, highlightJson, highlightMarkup, parseCsv, prettyJson, prettyXml, responseView, statusClass } from '../../src/response';
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
  const t = responseView(res({ headers: [['content-type', 'text/plain']], body: Buffer.from('<p>hi</p>') }), 'GET');
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

test('responseView: body terpotong & biner diberi catatan + aksi', () => {
  const t = responseView(res({ headers: [['content-type', 'text/plain']], body: Buffer.from('abc'), size: 3 * 1048576, truncated: true, bodyFile: '/c/b.txt' }), 'GET');
  assert.equal(t.note, 'Showing the first 1.0 MB of 3.0 MB.');
  assert.equal(t.canOpen, true);
  assert.equal(t.canSave, true);
  const b = responseView(res({ headers: [['content-type', 'image/png']], size: 2048, binary: true, bodyFile: '/c/b.bin' }), 'GET');
  assert.equal(b.bodyHtml, '');
  assert.equal(b.note, 'Binary body (image/png, 2.0 KB).');
  assert.deepEqual([b.canOpen, b.canSave], [false, true]);
  const n = responseView(res({ body: Buffer.from('x'), size: 1 }), 'GET');
  assert.deepEqual([n.note, n.canOpen, n.canSave], [undefined, false, false]);
});

test('prettyXml: indent 2 spasi, elemen teks pendek satu baris; bukan XML = undefined', () => {
  assert.equal(prettyXml('<?xml version="1.0"?><a><b x="1">t</b><c/><!-- n --></a>'),
    '<?xml version="1.0"?>\n<a>\n  <b x="1">t</b>\n  <c/>\n  <!-- n -->\n</a>');
  assert.equal(prettyXml('<a>\n   <b>1</b>\n</a>'), '<a>\n  <b>1</b>\n</a>');
  assert.equal(prettyXml('plain'), undefined);
});

test('highlightMarkup: nama tag, nilai atribut, komentar diberi warna; teks di-escape', () => {
  assert.equal(highlightMarkup('<?xml version="1.0"?>'), '<span class="c">&lt;?xml version=&quot;1.0&quot;?&gt;</span>');
  const html = highlightMarkup('<p class="x">a & b</p><!-- c --><br/>');
  assert.equal(html, '<span class="p">&lt;</span><span class="t">p</span> <span class="a">class</span>=<span class="s">&quot;x&quot;</span><span class="p">&gt;</span>a &amp; b<span class="p">&lt;/</span><span class="t">p</span><span class="p">&gt;</span><span class="c">&lt;!-- c --&gt;</span><span class="p">&lt;</span><span class="t">br</span><span class="p">/&gt;</span>');
});

test('parseCsv: kutip, koma & baris baru di dalam kutip, "" = kutip, pemisah ; terdeteksi', () => {
  assert.deepEqual(parseCsv('a,b\n1,"x, y"\n2,"say ""hi"""\n3,"multi\nline"\n'), [['a', 'b'], ['1', 'x, y'], ['2', 'say "hi"'], ['3', 'multi\nline']]);
  assert.deepEqual(parseCsv('a;b\r\n1;2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv(''), []);
});

test('responseView: format sesuai Content-Type (JSON, XML, HTML, CSV, text, binary)', () => {
  const v = (ct: string, body: string) => responseView(res({ headers: [['content-type', ct]], body: Buffer.from(body), size: body.length }), 'GET');
  assert.equal(v('application/json', '{}').format, 'JSON');
  const xml = v('application/xml; charset=utf-8', '<a><b>1</b></a>');
  assert.equal(xml.format, 'XML');
  const tag = (t: string, close = '') => `<span class="p">&lt;${close}</span><span class="t">${t}</span><span class="p">&gt;</span>`;
  assert.equal(xml.bodyHtml, `${tag('a')}\n  ${tag('b')}1${tag('b', '/')}\n${tag('a', '/')}`);
  assert.equal(v('image/svg+xml', '<svg/>').format, 'XML');
  const html = v('text/html', '<p>hi</p>');
  assert.equal(html.format, 'HTML');
  assert.match(html.bodyHtml, /<span class="t">p<\/span><span class="p">&gt;<\/span>hi/);
  const csv = v('text/csv', 'name,qty\n<b>,2\n');
  assert.equal(csv.format, 'CSV');
  assert.equal(csv.bodyHtml, '<table class="csv"><thead><tr><th>name</th><th>qty</th></tr></thead><tbody><tr><td>&lt;b&gt;</td><td>2</td></tr></tbody></table>');
  assert.equal(v('text/plain', 'a <b>').format, 'Text');
  assert.equal(v('text/plain', 'a <b>').bodyHtml, 'a &lt;b&gt;');
  assert.equal(responseView(res({ headers: [['content-type', 'application/pdf']], binary: true, size: 9, bodyFile: '/x' }), 'GET').format, 'Binary');
});

test('responseView: CSV besar dibatasi 1.000 baris tabel + catatan', () => {
  const body = `n\n${Array.from({ length: 1500 }, (_, i) => i).join('\n')}\n`;
  const v = responseView(res({ headers: [['content-type', 'text/csv']], body: Buffer.from(body), size: body.length }), 'GET');
  assert.equal((v.bodyHtml.match(/<tr>/g) ?? []).length, 1 + 1000);
  assert.equal(v.note, 'Showing the first 1,000 of 1,500 rows.');
});

test('responseView: tab Cookies (Set-Cookie semua hop) + Timeline (rantai redirect + cookie per hop)', () => {
  const v = responseView(res({
    url: 'http://bima.test/home', status: 200, statusText: 'OK',
    headers: [['content-type', 'text/html'], ['set-cookie', 'theme=dark; Path=/; Max-Age=60']],
    redirects: [{ status: 302, url: 'http://bima.test/login', setCookies: ['JSESSIONID=S1; Path=/; HttpOnly'] }],
  }), 'POST');
  assert.deepEqual(v.cookies.map((c) => [c.name, c.value, c.domain, c.path, c.httpOnly, c.session]), [
    ['JSESSIONID', 'S1', 'bima.test', '/', true, true], ['theme', 'dark', 'bima.test', '/', false, false],
  ]);
  assert.deepEqual(v.timeline, [
    { status: 302, url: 'http://bima.test/login', cookies: ['JSESSIONID'] },
    { status: 200, url: 'http://bima.test/home', cookies: ['theme'] },
  ]);
  assert.deepEqual(responseView(res({}), 'GET').cookies, []);
});

test('review R41: tabStatus = status ringkas untuk tab response per request', () => {
  assert.deepEqual(tabStatus(undefined), { text: '', cls: '' });
  assert.deepEqual(tabStatus({ kind: 'running' }), { text: '…', cls: 'run' });
  assert.deepEqual(tabStatus({ kind: 'queued' }), { text: '…', cls: 'run' });
  assert.deepEqual(tabStatus({ kind: 'response', status: '201 Created', statusClass: 'st-2' }), { text: '201', cls: 'st-2' });
  assert.deepEqual(tabStatus({ kind: 'error' }), { text: 'Error', cls: 'st-5' });
  assert.deepEqual(tabStatus({ kind: 'cancelled' }), { text: 'Cancelled', cls: 'st-1' });
});
