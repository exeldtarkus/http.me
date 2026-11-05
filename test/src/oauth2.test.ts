import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { accessToken, authorizeUrl, parseRedirect, pkcePair, tokenKey, type OAuthDeps, type OAuthToken } from '../../src/oauth2';
import { send } from '../../src/http';

type Seen = { url: string; auth?: string; form: URLSearchParams }[];

/** server OAuth tiruan: /token menerima grant, /authorize dipanggil "browser" (lihat authorize di bawah) */
async function mock(handler: (form: URLSearchParams, seen: Seen) => { status?: number; body: object }) {
  const seen: Seen = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(parts).toString());
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, form });
      const out = handler(form, seen);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, seen, close: () => server.close() };
}

const memory = () => {
  let t: OAuthToken | undefined;
  return { load: async () => t, save: async (x: OAuthToken | undefined) => { t = x; }, get: () => t };
};
const deps = (m: ReturnType<typeof memory>, extra: Partial<OAuthDeps> = {}): OAuthDeps => ({
  now: () => 1_000_000,
  send: async (r) => { const res = await send(r, {}); return { status: res.status, body: res.body.toString('utf8') }; },
  load: m.load, save: m.save, ...extra,
});

test('client_credentials: Basic header, scope, token disimpan; dipakai ulang sampai kedaluwarsa lalu diminta lagi', async () => {
  let n = 0;
  const s = await mock(() => ({ body: { access_token: `tok${++n}`, token_type: 'Bearer', expires_in: 60 } }));
  try {
    const m = memory();
    const f = { grant: 'client_credentials', token_url: `${s.base}/token`, client_id: 'cid', client_secret: 'sec', scope: 'a b' };
    assert.equal((await accessToken(f, deps(m))).access_token, 'tok1');
    assert.equal(s.seen[0].auth, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
    assert.equal(s.seen[0].form.get('grant_type'), 'client_credentials');
    assert.equal(s.seen[0].form.get('scope'), 'a b');
    assert.equal(m.get()!.expires_at, 1_000_000 + 60_000);
    assert.equal((await accessToken(f, deps(m))).access_token, 'tok1', 'masih berlaku: tidak ke server');
    assert.equal(s.seen.length, 1);
    assert.equal((await accessToken(f, deps(m, { now: () => 1_000_000 + 40_000 }))).access_token, 'tok2', 'kurang dari 30 dtk lagi = dianggap habis');
  } finally { s.close(); }
});

test('password grant + refresh otomatis (refresh_token), refresh gagal -> grant penuh', async () => {
  let n = 0;
  const s = await mock((form) => {
    if (form.get('grant_type') === 'refresh_token') return form.get('refresh_token') === 'r1' ? { body: { access_token: 'fresh', expires_in: 60, refresh_token: 'r2' } } : { status: 400, body: { error: 'invalid_grant' } };
    return { body: { access_token: `pw${++n}`, expires_in: 10, refresh_token: 'r1' } };
  });
  try {
    const m = memory();
    const f = { grant: 'password', token_url: `${s.base}/token`, client_id: 'c', username: 'u', password: 'p' };
    assert.equal((await accessToken(f, deps(m))).access_token, 'pw1');
    assert.equal(s.seen[0].form.get('username'), 'u');
    assert.equal(s.seen[0].auth, undefined, 'tanpa client_secret: client_id di body');
    assert.equal(s.seen[0].form.get('client_id'), 'c');
    const later = deps(m, { now: () => 2_000_000 });
    assert.equal((await accessToken(f, later)).access_token, 'fresh');
    assert.equal(m.get()!.refresh_token, 'r2');
    m.save({ ...m.get()!, refresh_token: 'bad', expires_at: 0 });
    assert.equal((await accessToken(f, later)).access_token, 'pw2', 'refresh ditolak -> ulang password grant');
  } finally { s.close(); }
});

test('authorization_code + PKCE: code_challenge S256 cocok dengan code_verifier di token request; state dicek', async () => {
  let challenge = '';
  const s = await mock((form) => (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === challenge && form.get('code') === 'CODE'
    ? { body: { access_token: 'ac', expires_in: 60, scope: 'x' } } : { status: 400, body: { error: 'invalid_grant', error_description: 'bad verifier' } }));
  try {
    const m = memory();
    const f = { grant: 'authorization_code', token_url: `${s.base}/token`, authorization_url: `${s.base}/authorize`, client_id: 'c', redirect_uri: 'http://127.0.0.1:8123/cb', scope: 'x' };
    const authorize = async (url: string) => {
      const u = new URL(url);
      challenge = u.searchParams.get('code_challenge')!;
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(u.searchParams.get('response_type'), 'code');
      assert.equal(u.searchParams.get('client_id'), 'c');
      return `http://127.0.0.1:8123/cb?code=CODE&state=${u.searchParams.get('state')}`;
    };
    assert.equal((await accessToken(f, deps(m, { authorize }))).access_token, 'ac');
    assert.equal(s.seen[0].form.get('redirect_uri'), 'http://127.0.0.1:8123/cb');
    await assert.rejects(accessToken({ ...f, client_id: 'c2' }, deps(memory(), { authorize: async () => 'http://127.0.0.1:8123/cb?code=CODE&state=WRONG' })), /state/i);
    await assert.rejects(accessToken({ ...f, client_id: 'c3' }, deps(memory(), { authorize: async (url) => `http://127.0.0.1:8123/cb?error=access_denied&state=${new URL(url).searchParams.get('state')}` })), /access_denied/);
    await assert.rejects(accessToken(f, deps(memory())), /browser/i, 'tanpa authorize (mis. tanpa UI) = pesan jelas');
    const p = pkcePair();
    assert.equal(createHash('sha256').update(p.verifier).digest('base64url'), p.challenge);
    assert.ok(p.verifier.length >= 43 && p.verifier.length <= 128);
  } finally { s.close(); }
});

test('implicit: token dari fragment redirect; error server -> pesan error_description tanpa membocorkan secret', async () => {
  const s = await mock(() => ({ status: 401, body: { error: 'invalid_client', error_description: 'Client authentication failed' } }));
  try {
    const f = { grant: 'implicit', authorization_url: 'http://x/authorize', client_id: 'c', redirect_uri: 'http://127.0.0.1:8123/cb' };
    const t = await accessToken(f, deps(memory(), { authorize: async (url) => `http://127.0.0.1:8123/cb#access_token=IMP&token_type=bearer&expires_in=30&state=${new URL(url).searchParams.get('state')}` }));
    assert.equal(t.access_token, 'IMP');
    assert.equal(t.expires_at, 1_000_000 + 30_000);
    await assert.rejects(accessToken({ grant: 'client_credentials', token_url: `${s.base}/token`, client_id: 'c', client_secret: 'TOPSECRET' }, deps(memory())),
      (e: Error) => /invalid_client/.test(e.message) && /Client authentication failed/.test(e.message) && !e.message.includes('TOPSECRET'));
    await assert.rejects(accessToken({ grant: 'client_credentials' }, deps(memory())), /token_url/);
    await assert.rejects(accessToken({ grant: 'bogus', token_url: 'http://x' }, deps(memory())), /Unsupported OAuth 2.0 grant/);
  } finally { s.close(); }
});

test('authorizeUrl / parseRedirect / tokenKey', () => {
  const u = new URL(authorizeUrl({ authorization_url: 'https://idp.test/auth?x=1', client_id: 'c', redirect_uri: 'http://127.0.0.1:1/cb', scope: 'a b' }, 'code', 'ST', 'CH'));
  assert.equal(u.searchParams.get('x'), '1');
  assert.equal(u.searchParams.get('scope'), 'a b');
  assert.equal(u.searchParams.get('code_challenge'), 'CH');
  assert.equal(authorizeUrl({ authorization_url: 'https://idp.test/auth', client_id: 'c' }, 'token', 'ST').includes('code_challenge'), false);
  assert.deepEqual(parseRedirect('http://h/cb?code=1&state=s'), { code: '1', state: 's' });
  assert.deepEqual(parseRedirect('http://h/cb#access_token=t&expires_in=5&state=s'), { access_token: 't', expires_in: '5', state: 's' });
  assert.notEqual(tokenKey({ grant: 'password', token_url: 'a', client_id: 'x' }), tokenKey({ grant: 'password', token_url: 'a', client_id: 'y' }));
  assert.equal(tokenKey({ grant: 'password', token_url: 'a', client_id: 'x', password: 'p1' }), tokenKey({ grant: 'password', token_url: 'a', client_id: 'x', password: 'p2' }), 'secret tidak ikut kunci');
});

import { loopback } from '../../src/oauth2Loopback';

/** "browser" tiruan: membuka URL authorize = langsung memanggil redirect_uri dengan code (atau fragment lewat /__fragment) */
test('loopback: redirect_uri otomatis di 127.0.0.1, code diterima; fragment (implicit) lewat halaman perantara; timeout / abort menutup server', async () => {
  const lb = await loopback(undefined, 2000);
  try {
    assert.match(lb.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const flow = lb.wait(new AbortController().signal);
    const code = await fetch(`${lb.redirectUri}?code=C1&state=S`);
    assert.equal(code.status, 200);
    assert.match(await code.text(), /You can close this tab/);
    assert.equal(await flow, `${lb.redirectUri}?code=C1&state=S`);
  } finally { lb.close(); }

  const imp = await loopback(undefined, 2000);
  try {
    const flow = imp.wait(new AbortController().signal);
    const page = await (await fetch(imp.redirectUri)).text(); // tanpa query: halaman JS yang meneruskan fragment
    assert.match(page, /__fragment/);
    await fetch(`http://127.0.0.1:${new URL(imp.redirectUri).port}/__fragment?access_token=T&state=S`);
    assert.equal(await flow, `${imp.redirectUri}#access_token=T&state=S`);
  } finally { imp.close(); }

  const slow = await loopback(undefined, 50);
  await assert.rejects(slow.wait(new AbortController().signal), /timed out/i);
  slow.close();
  const ac = new AbortController();
  const aborted = await loopback(undefined, 5000);
  const w = aborted.wait(ac.signal);
  ac.abort();
  await assert.rejects(w, /cancelled/i);
  aborted.close();
  await assert.rejects(loopback('https://example.com/cb', 10), /loopback/i);
  const fixed = await loopback('http://localhost:0/cb2', 10);
  assert.match(fixed.redirectUri, /^http:\/\/localhost:\d+\/cb2$/);
  fixed.close();
});
