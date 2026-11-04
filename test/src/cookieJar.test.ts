import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cookieHeader, jarCookieValues, loadJar, parseCookiePaste, parseSetCookie, saveJar, storeCookies, type Cookie } from '../../src/cookieJar';
import { withTempDir } from './helpers/tmp';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const u = (s: string) => new URL(s);

test('parseSetCookie: atribut Domain / Path / Secure / HttpOnly / Expires / Max-Age / SameSite; default host-only + path default', () => {
  assert.deepEqual(parseSetCookie('JSESSIONID=ABC; Path=/; HttpOnly', u('http://bima.test/login'), NOW), {
    name: 'JSESSIONID', value: 'ABC', domain: 'bima.test', hostOnly: true, path: '/', secure: false, httpOnly: true, created: NOW,
  });
  const c = parseSetCookie('t=1; Domain=.Example.com; Secure; Max-Age=60; SameSite=Lax; Expires=Thu, 01 Jan 2099 00:00:00 GMT', u('https://api.example.com/a/b/c'), NOW)!;
  assert.deepEqual([c.domain, c.hostOnly, c.path, c.secure, c.expires, c.sameSite], ['example.com', false, '/a/b', true, NOW + 60_000, 'Lax'], 'Max-Age menang atas Expires');
  assert.equal(parseSetCookie('x=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT', u('http://a.test/'), NOW)!.expires, Date.UTC(2015, 9, 21, 7, 28));
  assert.equal(parseSetCookie('x=1; Domain=other.test', u('http://a.test/'), NOW), undefined, 'Domain lain ditolak');
  assert.equal(parseSetCookie('=novalue', u('http://a.test/'), NOW), undefined);
  assert.equal(parseSetCookie('x="q v"', u('http://a.test/'), NOW)!.value, '"q v"');
});

test('storeCookies: ganti cookie nama+domain+path sama, hapus dengan Max-Age=0 / Expires lampau, buang yang kedaluwarsa', () => {
  let jar: Cookie[] = [];
  jar = storeCookies(jar, ['a=1; Path=/', 'b=2; Path=/x', 'old=1; Max-Age=10'], u('http://h.test/x/y'), NOW);
  jar = storeCookies(jar, ['a=9; Path=/'], u('http://h.test/'), NOW + 1);
  assert.deepEqual(jar.map((c) => `${c.name}=${c.value}`), ['b=2', 'old=1', 'a=9']);
  jar = storeCookies(jar, ['b=; Path=/x; Max-Age=0', 'a=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], u('http://h.test/x'), NOW + 2);
  assert.deepEqual(jar.map((c) => c.name), ['old']);
  assert.deepEqual(storeCookies(jar, [], u('http://h.test/'), NOW + 11_000), [], 'kedaluwarsa dibuang');
});

test('cookieHeader: cocok domain (host-only vs subdomain), path, Secure, belum kedaluwarsa; path lebih panjang dulu', () => {
  const jar = storeCookies([], ['root=1; Path=/', 'deep=2; Path=/api/v1', 'sec=3; Secure; Path=/', 'wide=4; Domain=example.com; Path=/', 'exp=5; Max-Age=5; Path=/'], u('https://www.example.com/api/v1/x'), NOW);
  assert.equal(cookieHeader(jar, u('https://www.example.com/api/v1/users'), NOW), 'deep=2; root=1; sec=3; wide=4; exp=5');
  assert.equal(cookieHeader(jar, u('http://www.example.com/api/v2'), NOW), 'root=1; wide=4; exp=5', 'Secure hanya https, path lain');
  assert.equal(cookieHeader(jar, u('https://sub.example.com/'), NOW), 'wide=4', 'host-only tidak ke subdomain lain');
  assert.equal(cookieHeader(jar, u('https://example.org/'), NOW), undefined);
  assert.equal(cookieHeader(jar, u('https://www.example.com/'), NOW + 6000), 'root=1; sec=3; wide=4');
  assert.equal(cookieHeader(jar, u('https://www.example.com/apix'), NOW), 'root=1; sec=3; wide=4; exp=5', '/api/v1 tidak cocok /apix');
});

test('parseCookiePaste: "Cookie: a=1; b=2", "a=1; b=2", baris Set-Cookie, satu "JSESSIONID=x"', () => {
  assert.deepEqual(parseCookiePaste('Cookie: a=1; b=two', 'h.test', NOW).map((c) => [c.name, c.value, c.domain, c.path, c.hostOnly]), [['a', '1', 'h.test', '/', true], ['b', 'two', 'h.test', '/', true]]);
  assert.deepEqual(parseCookiePaste('JSESSIONID=XYZ', 'h.test', NOW).map((c) => c.name), ['JSESSIONID']);
  assert.deepEqual(parseCookiePaste('Set-Cookie: s=1; Path=/app; HttpOnly', 'h.test', NOW).map((c) => [c.name, c.path, c.httpOnly]), [['s', '/app', true]]);
  assert.deepEqual(parseCookiePaste('nothing here', 'h.test', NOW), []);
});

test('saveJar / loadJar: chunk per Environment + domain di httpme-cache/cookies (0600), cookie session ikut, domain kosong dihapus', async () => {
  await withTempDir(async (dir) => {
    const jar = storeCookies([], ['s=1'], u('http://a.test/'), NOW).concat(storeCookies([], ['t=tok2; Max-Age=3600'], u('http://b.test/'), NOW));
    await saveJar(dir, 'dev', jar);
    await saveJar(dir, 'uat', storeCookies([], ['u=3'], u('http://a.test/'), NOW));
    assert.deepEqual(readdirSync(dir).sort(), ['dev%7Ca.test.json', 'dev%7Cb.test.json', 'uat%7Ca.test.json']);
    assert.equal(statSync(join(dir, 'dev%7Ca.test.json')).mode & 0o777, 0o600);
    assert.deepEqual((await loadJar(dir, 'dev')).map((c) => c.name).sort(), ['s', 't'], 'cookie session (tanpa Expires) tetap tersimpan');
    await saveJar(dir, 'dev', jar.filter((c) => c.name === 't'));
    assert.deepEqual(readdirSync(dir).sort(), ['dev%7Cb.test.json', 'uat%7Ca.test.json']);
    assert.deepEqual((await loadJar(dir, 'uat')).map((c) => c.name), ['u']);
    assert.deepEqual(jarCookieValues(await loadJar(dir, 'dev')), ['tok2'], 'nilai 1 karakter tidak di-mask (log jadi rusak)');
  });
});
