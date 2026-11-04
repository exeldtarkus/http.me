import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { send, type SendOptions } from '../../src/http';
import { cookieHeader, storeCookies, type Cookie } from '../../src/cookieJar';
import { sendWithRelogin, sessionExpired } from '../../src/login';
import { startServer } from './helpers/server';

/** tiruan BIMA: POST /login (form) -> 302 /home + Set-Cookie JSESSIONID; tanpa cookie valid semua halaman 302 /login */
async function bima() {
  let session = '';
  let logins = 0;
  const srv = await startServer(async (req, body) => {
    const sid = /JSESSIONID=(\w+)/.exec(String(req.headers.cookie ?? ''))?.[1];
    if (req.url === '/login' && req.method === 'POST') {
      if (body !== 'username=u&password=p') return { status: 200, body: 'bad login' };
      logins++;
      session = `S${logins}`;
      return { status: 302, headers: { location: '/home', 'set-cookie': [`JSESSIONID=${session}; Path=/; HttpOnly`, 'theme=dark; Path=/'] } };
    }
    if (req.url === '/login') return { status: 200, body: '<form>login</form>' };
    if (!sid || sid !== session) return { status: 302, headers: { location: '/login' } };
    return { status: 200, body: `home ${sid}` };
  });
  return { srv, logins: () => logins, expire: () => { session = 'gone'; } };
}

/** jar di memory untuk opsi cookies send() */
function memJar(): { jar: () => Cookie[]; opts: NonNullable<SendOptions['cookies']> } {
  let jar: Cookie[] = [];
  return { jar: () => jar, opts: { get: (url) => cookieHeader(jar, url, Date.now()), set: (url, list) => { jar = storeCookies(jar, list, url, Date.now()); } } };
}

test('redirect manual + cookie tiap hop: POST /login -> 302 + Set-Cookie -> GET /home dengan cookie (pola BIMA)', async () => {
  const b = await bima();
  try {
    const j = memJar();
    const res = await send({ method: 'POST', url: `${b.srv.url}/login`, headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: 'username=u&password=p' }, { cookies: j.opts });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'home S1', 'cookie dari response 302 dikirim ke hop berikutnya');
    assert.deepEqual(res.redirects?.map((r) => [r.status, r.setCookies]), [[302, ['JSESSIONID=S1; Path=/; HttpOnly', 'theme=dark; Path=/']]]);
    assert.deepEqual(j.jar().map((c) => c.name), ['JSESSIONID', 'theme']);
    // header Cookie milik request menang, cookie jar lain ditambahkan
    const again = await send({ method: 'GET', url: `${b.srv.url}/home`, headers: [['Cookie', 'theme=light']] }, { cookies: j.opts });
    assert.equal(again.body.toString(), 'home S1');
    // tanpa jar: tidak ada cookie -> dilempar ke /login
    const none = await send({ method: 'GET', url: `${b.srv.url}/home`, headers: [] });
    assert.equal(none.url, `${b.srv.url}/login`);
  } finally {
    await b.srv.close();
  }
});

test('sessionExpired: redirect ke pola /login, URL akhir /login, 401 / 403', () => {
  const base = { status: 200, url: 'http://a/home', redirects: [] as { status: number; url: string }[], headers: [] as [string, string][] };
  assert.equal(sessionExpired(base, '/login'), false);
  assert.equal(sessionExpired({ ...base, url: 'http://a/login?next=/x' }, '/login'), true);
  assert.equal(sessionExpired({ ...base, status: 401 }, '/login'), true);
  assert.equal(sessionExpired({ ...base, status: 403 }, '/login'), true);
  assert.equal(sessionExpired({ ...base, status: 302, url: 'http://a/x', headers: [['location', '/auth/login']] }, '/login'), true, '@no-redirect: Location');
  assert.equal(sessionExpired({ ...base, url: 'http://a/sso' }, 'sso'), true, 'pola diatur user');
});

test('auto re-login: session habis -> login sekali -> ulang request; login gagal tidak loop', async () => {
  const b = await bima();
  try {
    const j = memJar();
    const login = () => send({ method: 'POST', url: `${b.srv.url}/login`, headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: 'username=u&password=p' }, { cookies: j.opts });
    const home = () => send({ method: 'GET', url: `${b.srv.url}/home`, headers: [] }, { cookies: j.opts });
    const first = await sendWithRelogin(home, (r) => sessionExpired(r, '/login'), login);
    assert.deepEqual([first.res.body.toString(), first.relogged, b.logins()], ['home S1', true, 1]);
    const ok = await sendWithRelogin(home, (r) => sessionExpired(r, '/login'), login);
    assert.deepEqual([ok.relogged, b.logins()], [false, 1], 'session masih valid: tanpa login');
    b.expire();
    const again = await sendWithRelogin(home, (r) => sessionExpired(r, '/login'), login);
    assert.deepEqual([again.res.body.toString(), b.logins()], ['home S2', 2]);
    // login yang selalu gagal: dicoba sekali, hasil tetap halaman login (tidak loop)
    let tries = 0;
    const badLogin = async () => { tries++; return send({ method: 'POST', url: `${b.srv.url}/login`, headers: [], body: 'wrong' }); };
    b.expire();
    const bad = await sendWithRelogin(home, (r) => sessionExpired(r, '/login'), badLogin);
    assert.deepEqual([tries, bad.relogged, bad.res.url], [1, true, `${b.srv.url}/login`]);
    assert.equal((await sendWithRelogin(home, (r) => sessionExpired(r, '/login'), undefined)).relogged, false, 'tanpa request login');
  } finally {
    await b.srv.close();
  }
});
