import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify as cryptoVerify, createHmac } from 'node:crypto';
import { applyAuth, headerAuth, oauth1Signature, sendWithDigest, digestAuthorization, parseAuth, parseDigestChallenge } from '../../src/auth';
import type { HttpRequest } from '../../src/http';
import type { Header } from '../../src/httpFile';

const headers = (...values: [string, string, boolean][]): Header[] =>
  values.map(([name, value, enabled]) => ({ name, value, enabled }));

test('parseAuth: default inherit and explicit No Auth', () => {
  assert.deepEqual(parseAuth(undefined, []), { type: 'inherit', fields: {} });
  assert.deepEqual(parseAuth('none', []), { type: 'none', fields: {} });
});

test('parseAuth: API Key metadata supports header and query placement', () => {
  assert.deepEqual(
    parseAuth('apikey key=X-Api-Key value={{apiKey}} in=header', []),
    { type: 'apiKey', fields: { key: 'X-Api-Key', value: '{{apiKey}}', in: 'header' } },
  );
  assert.deepEqual(
    parseAuth('apiKey key=api_key value=secret in=query', []),
    { type: 'apiKey', fields: { key: 'api_key', value: 'secret', in: 'query' } },
  );
});

test('parseAuth: Basic header decodes UTF-8 and splits credentials at the first colon', () => {
  const encoded = Buffer.from('usér:pa:ss🔐').toString('base64');
  assert.deepEqual(
    parseAuth(undefined, headers(['Authorization', `Basic ${encoded}`, true])),
    { type: 'basic', fields: { username: 'usér', password: 'pa:ss🔐' } },
  );
});

test('parseAuth: Bearer header and disabled Authorization header', () => {
  assert.deepEqual(
    parseAuth(undefined, headers(['Authorization', 'Bearer abc.def', true])),
    { type: 'bearer', fields: { token: 'abc.def' } },
  );
  assert.deepEqual(
    parseAuth(undefined, headers(['Authorization', 'Bearer ignored', false])),
    { type: 'inherit', fields: {} },
  );
});

test('parseAuth: malformed auth metadata and unsupported Authorization schemes fail explicitly', () => {
  assert.throws(() => parseAuth('', []), /Auth metadata is empty/);
  assert.throws(() => parseAuth('basic username=user', []), /password/);
  assert.throws(() => parseAuth('apikey key=X-Key value=x in=cookie', []), /in must be header or query/);
  assert.throws(() => parseAuth('madeup token=x', []), /Unsupported auth type/);
  assert.throws(() => parseAuth(undefined, headers(['Authorization', 'Bearer', true])), /Invalid Bearer Authorization header/);
  assert.throws(() => parseAuth(undefined, headers(['Authorization', 'Token abc', true])), /Unsupported Authorization scheme/);
  assert.throws(() => parseAuth(undefined, headers(['Authorization', 'Digest abc', true])), /Invalid Digest Authorization header/);
});

test('parseAuth: malformed field error does not leak the secret', () => {
  const secret = 'S3cr3t-T0ken';
  assert.throws(
    () => parseAuth(`bearer ${secret}`, []),
    (e: Error) => /Invalid auth field/.test(e.message) && !e.message.includes(secret),
  );
});

test('applyAuth: Basic encodes UTF-8 credentials including colons and does not mutate the request', () => {
  const request: HttpRequest = {
    method: 'GET', url: 'https://api.test/path',
    headers: [['authorization', 'old'], ['X-Trace', '1']],
  };
  const result = applyAuth(request, { type: 'basic', fields: { username: '{{user}}', password: '{{pass}}' } }, new Map([
    ['user', 'usér'], ['pass', 'pa:ss🔐'],
  ]));
  assert.deepEqual(result, {
    request: {
      method: 'GET', url: 'https://api.test/path',
      headers: [['X-Trace', '1'], ['Authorization', `Basic ${Buffer.from('usér:pa:ss🔐').toString('base64')}`]],
    },
    generatedHeaders: ['Authorization'],
  });
  assert.deepEqual(request.headers, [['authorization', 'old'], ['X-Trace', '1']]);
});

test('applyAuth: API Key is placed in a header or query and existing values are replaced', () => {
  const request: HttpRequest = {
    method: 'GET', url: 'https://api.test/path?keep=yes&api_key=old',
    headers: [['x-api-key', 'old'], ['X-Trace', '1']],
  };
  const header = applyAuth(request, { type: 'apiKey', fields: { key: 'X-Api-Key', value: '{{key}}', in: 'header' } }, new Map([['key', 'new value']]));
  assert.deepEqual(header.request.headers, [['X-Trace', '1'], ['X-Api-Key', 'new value']]);
  assert.deepEqual(header.generatedHeaders, ['X-Api-Key']);
  const query = applyAuth(request, { type: 'apiKey', fields: { key: 'api_key', value: 'new value', in: 'query' } }, new Map());
  assert.equal(new URL(query.request.url).searchParams.get('keep'), 'yes');
  assert.equal(new URL(query.request.url).searchParams.get('api_key'), 'new value');
  assert.deepEqual(query.generatedHeaders, []);
  assert.equal(request.url, 'https://api.test/path?keep=yes&api_key=old');
});

test('applyAuth: Bearer resolves token and No Auth removes Authorization headers', () => {
  const request: HttpRequest = { method: 'GET', url: 'https://api.test', headers: [['Authorization', 'Basic old'], ['X-Trace', '1']] };
  const bearer = applyAuth(request, { type: 'bearer', fields: { token: '{{accessToken}}' } }, new Map([['accessToken', 'new-token']]));
  assert.deepEqual(bearer.request.headers, [['X-Trace', '1'], ['Authorization', 'Bearer new-token']]);
  assert.deepEqual(bearer.generatedHeaders, ['Authorization']);
  const none = applyAuth(request, { type: 'none', fields: {} }, new Map());
  assert.deepEqual(none.request.headers, [['X-Trace', '1']]);
  assert.deepEqual(none.generatedHeaders, []);
});

test('applyAuth: missing variables, malformed fields, and advanced algorithms fail explicitly', () => {
  const request: HttpRequest = { method: 'GET', url: 'https://api.test', headers: [] };
  assert.throws(
    () => applyAuth(request, { type: 'bearer', fields: { token: '{{missing}}' } }, new Map()),
    /Missing auth value: missing/,
  );
  assert.throws(
    () => applyAuth(request, { type: 'bearer', fields: { token: '{{empty}}' } }, new Map([['empty', '']])),
    /bearer auth requires a token/,
  );
  assert.throws(
    () => applyAuth(request, { type: 'apiKey', fields: { key: 'X-Key', value: 'x', in: 'cookie' } }, new Map()),
    /in must be header or query/,
  );
  assert.throws(
    () => applyAuth(request, { type: 'oauth2', fields: {} }, new Map()),
    /Auth type oauth2 is not supported yet/,
  );
});

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const jwtPart = (t: string, i: number) => JSON.parse(Buffer.from(t.split('.')[i], 'base64url').toString('utf8'));
const get: HttpRequest = { method: 'GET', url: 'https://api.test/x', headers: [] };

test('applyAuth: JWT HS256 signs header.payload with the secret, {{var}} in payload, prefix, and query placement', () => {
  const r = applyAuth(get, { type: 'jwt', fields: { algorithm: 'HS256', secret: 'k3y', payload: '{"sub":"{{user}}"}' } }, new Map([['user', 'u1']]));
  const token = r.request.headers.find(([n]) => n === 'Authorization')![1].replace(/^Bearer /, '');
  const [h, p, sig] = token.split('.');
  assert.deepEqual(jwtPart(token, 0), { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(jwtPart(token, 1), { sub: 'u1' });
  assert.equal(sig, createHmac('sha256', 'k3y').update(`${h}.${p}`).digest('base64url'));
  assert.deepEqual(r.generatedHeaders, ['Authorization']);
  const q = applyAuth(get, { type: 'jwt', fields: { secret: Buffer.from('k3y').toString('base64'), secret_base64: 'true', add_to: 'query' } }, new Map());
  const t = new URL(q.request.url).searchParams.get('token')!;
  assert.equal(t.split('.')[2], createHmac('sha256', 'k3y').update(t.split('.').slice(0, 2).join('.')).digest('base64url'));
  const pre = applyAuth(get, { type: 'jwt', fields: { secret: 'k', prefix: 'JWT' } }, new Map());
  assert.match(pre.request.headers[0][1], /^JWT /);
  assert.throws(() => applyAuth(get, { type: 'jwt', fields: { secret: 'k', payload: '{bad' } }, new Map()), /payload must be valid JSON/);
});

test('applyAuth: JWT RS256 / PS256 / ES256 signatures verify with the public key', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = (k: { export(o: object): string | Buffer }) => String(k.export({ type: 'pkcs8', format: 'pem' }));
  for (const [alg, pair, opts] of [['RS256', rsa, {}], ['PS256', rsa, { padding: 6, saltLength: 32 }], ['ES256', ec, { dsaEncoding: 'ieee-p1363' }]] as const) {
    const r = applyAuth(get, { type: 'jwt', fields: { algorithm: alg, secret: pem(pair.privateKey) } }, new Map());
    const token = r.request.headers[0][1].replace(/^Bearer /, '');
    const [h, p, sig] = token.split('.');
    assert.equal(jwtPart(token, 0).alg, alg);
    assert.ok(cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: pair.publicKey, ...opts }, Buffer.from(sig, 'base64url')), alg);
  }
  assert.throws(() => applyAuth(get, { type: 'jwt', fields: { algorithm: 'none', secret: 'k' } }, new Map()), /Unsupported JWT algorithm/);
});

test('applyAuth: AWS SigV4 matches the AWS "get-vanilla" test vector (and session token)', () => {
  const fields = { access_key: 'AKIDEXAMPLE', secret_key: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' };
  const req: HttpRequest = { method: 'GET', url: 'https://example.amazonaws.com/', headers: [] };
  const r = applyAuth(req, { type: 'aws', fields }, new Map(), { now: new Date('2015-08-30T12:36:00Z') });
  const h = Object.fromEntries(r.request.headers);
  assert.equal(h['x-amz-date'], '20150830T123600Z');
  assert.equal(h.Authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  const t = applyAuth(req, { type: 'aws', fields: { ...fields, session_token: 'TOK' } }, new Map(), { now: new Date('2015-08-30T12:36:00Z') });
  assert.equal(Object.fromEntries(t.request.headers)['x-amz-security-token'], 'TOK');
  assert.match(Object.fromEntries(t.request.headers).Authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token/);
});

test('digest: RFC 2617 example (MD5, qop=auth) and RFC 7616-style SHA-256 / -sess / auth-int', () => {
  const challenge = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  assert.equal(challenge.realm, 'testrealm@host.com');
  assert.equal(challenge.qop, 'auth,auth-int');
  const req: HttpRequest = { method: 'GET', url: 'http://www.nowhere.org/dir/index.html', headers: [] };
  const h = digestAuthorization({ type: 'digest', fields: { username: 'Mufasa', password: 'Circle Of Life', nc: '00000001', cnonce: '0a4f113b' } }, req, challenge);
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(h, /^Digest username="Mufasa", realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", uri="\/dir\/index.html", qop=auth, nc=00000001, cnonce="0a4f113b", response="[0-9a-f]{32}", opaque="5ccc069c403ebaf9f0171e9517f40e41"$/);
  // SHA-256 dihitung ulang manual dari rumus RFC 7616
  const sha = (x: string) => createHash('sha256').update(x).digest('hex');
  const ch = { realm: 'r', nonce: 'n', qop: 'auth', algorithm: 'SHA-256' };
  const f = { username: 'u', password: 'p', nc: '00000001', cnonce: 'c' };
  const ha1 = sha('u:r:p');
  const want = sha(`${ha1}:n:00000001:c:auth:${sha('GET:/a?b=1')}`);
  const sha256 = digestAuthorization({ type: 'digest', fields: f }, { method: 'GET', url: 'http://h/a?b=1', headers: [] }, ch);
  assert.match(sha256, new RegExp(`algorithm=SHA-256.*response="${want}"`));
  const sess = digestAuthorization({ type: 'digest', fields: f }, { method: 'GET', url: 'http://h/a?b=1', headers: [] }, { ...ch, algorithm: 'SHA-256-sess' });
  assert.match(sess, new RegExp(`response="${sha(`${sha(`${ha1}:n:c`)}:n:00000001:c:auth:${sha('GET:/a?b=1')}`)}"`));
  const ai = digestAuthorization({ type: 'digest', fields: f }, { method: 'POST', url: 'http://h/a', headers: [], body: 'xyz' }, { ...ch, qop: 'auth-int' });
  assert.match(ai, new RegExp(`qop=auth-int.*response="${sha(`${ha1}:n:00000001:c:auth-int:${sha(`POST:/a:${sha('xyz')}`)}`)}"`));
  // tanpa qop: response = H(HA1:nonce:HA2), tanpa nc/cnonce di header
  const old = digestAuthorization({ type: 'digest', fields: f }, req, { realm: 'r', nonce: 'n', algorithm: 'SHA-256' });
  assert.doesNotMatch(old, /nc=|cnonce=/);
  assert.throws(() => digestAuthorization({ type: 'digest', fields: f }, req, { realm: 'r', nonce: 'n', algorithm: 'XYZ' }), /Unsupported Digest algorithm/);
});

test('sendWithDigest vs server lokal: 401 challenge -> retry sekali dengan response valid; retry=false / bukan Digest tidak mengulang', async () => {
  const http = await import('node:http');
  const { send } = await import('../../src/http');
  const md5 = (x: string) => createHash('md5').update(x).digest('hex');
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    const a = req.headers.authorization;
    if (req.url === '/basic') return void res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' }).end();
    if (a) {
      const f = Object.fromEntries([...a.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
      const want = md5(`${md5('Mufasa:srv:Circle Of Life')}:${f.nonce}:${f.nc}:${f.cnonce}:auth:${md5(`GET:${req.url}`)}`);
      if (f.response === want && f.username === 'Mufasa') return void res.writeHead(200).end('welcome');
    }
    res.writeHead(401, { 'www-authenticate': 'Digest realm="srv", nonce="abc123", qop="auth", algorithm=MD5' }).end('denied');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const cfg = { type: 'digest' as const, fields: { username: 'Mufasa', password: 'Circle Of Life' } };
    const req: HttpRequest = { method: 'GET', url: `${base}/secret?x=1`, headers: [] };
    const ok = await sendWithDigest(cfg, req, (r) => send(r, {}));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.toString(), 'welcome');
    assert.equal(hits, 2);
    hits = 0;
    const bad = await sendWithDigest({ ...cfg, fields: { ...cfg.fields, password: 'wrong' } }, req, (r) => send(r, {}));
    assert.equal(bad.status, 401);
    assert.equal(hits, 2); // sekali retry, tidak loop
    hits = 0;
    assert.equal((await sendWithDigest({ ...cfg, fields: { ...cfg.fields, retry: 'false' } }, req, (r) => send(r, {}))).status, 401);
    assert.equal(hits, 1);
    hits = 0;
    assert.equal((await sendWithDigest(cfg, { ...req, url: `${base}/basic` }, (r) => send(r, {}))).status, 401);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});

test('digest: vektor RFC 7616 §3.9.1 (MD5 dan SHA-256)', () => {
  const ch = { realm: 'http-auth@example.org', nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v', opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS', qop: 'auth' };
  const fields = { username: 'Mufasa', password: 'Circle of Life', nc: '00000001', cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ' };
  const req: HttpRequest = { method: 'GET', url: 'http://www.example.org/dir/index.html', headers: [] };
  assert.match(digestAuthorization({ type: 'digest', fields }, req, { ...ch, algorithm: 'MD5' }), /response="8ca523f5e9506fed4657c9700eebdbec"/);
  assert.match(digestAuthorization({ type: 'digest', fields }, req, { ...ch, algorithm: 'SHA-256' }), /response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"/);
});

test('parseAuth: header gaya REST Client — Digest user pass dan AWS id secret region:r service:s', () => {
  assert.deepEqual(parseAuth(undefined, headers(['Authorization', 'Digest Mufasa Circle of Life', true])),
    { type: 'digest', fields: { username: 'Mufasa', password: 'Circle of Life' } });
  assert.deepEqual(parseAuth(undefined, headers(['Authorization', 'AWS AKID SECRET region:us-east-1 service:s3 token:TOK', true])),
    { type: 'aws', fields: { access_key: 'AKID', secret_key: 'SECRET', region: 'us-east-1', service: 's3', session_token: 'TOK' } });
  assert.throws(() => parseAuth(undefined, headers(['Authorization', 'AWS AKID SECRET', true])), /region/);
  // header Digest mentah tidak ikut terkirim: password-nya hanya bahan hitung
  const r = applyAuth({ method: 'GET', url: 'http://h/', headers: [['Authorization', 'Digest u p']] }, { type: 'digest', fields: { username: 'u', password: 'p' } }, new Map());
  assert.deepEqual(r.request.headers, []);
});

test('applyAuth: Hawk — MAC dari string spec, payload hash, app/dlg', () => {
  const fields = { id: 'dh37fgj492je', key: 'werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn', algorithm: 'sha256', timestamp: '1353832234', nonce: 'j4h3g2', ext: 'some-app-data' };
  const req: HttpRequest = { method: 'GET', url: 'http://example.com:8000/resource/1?b=1&a=2', headers: [] };
  const h = applyAuth(req, { type: 'hawk', fields }, new Map()).request.headers.find(([n]) => n === 'Authorization')![1];
  // string ternormalisasi disusun manual dari spec Hawk (bukan vektor resmi: tidak ada salinan vektor yang bisa diverifikasi offline)
  const mac0 = createHmac('sha256', fields.key).update('hawk.1.header\n1353832234\nj4h3g2\nGET\n/resource/1?b=1&a=2\nexample.com\n8000\n\nsome-app-data\n').digest('base64');
  assert.equal(h, `Hawk id="dh37fgj492je", ts="1353832234", nonce="j4h3g2", ext="some-app-data", mac="${mac0}"`);
  const body: HttpRequest = { method: 'POST', url: 'http://example.com/x?a=1', headers: [['Content-Type', 'text/plain; charset=utf-8']], body: 'Thank you for flying Hawk' };
  const hb = applyAuth(body, { type: 'hawk', fields: { ...fields, ext: '' } }, new Map()).request.headers.find(([n]) => n === 'Authorization')![1];
  const hash = createHash('sha256').update('hawk.1.payload\ntext/plain\nThank you for flying Hawk\n').digest('base64');
  assert.match(hb, new RegExp(`hash="${hash.replace(/[+/=]/g, '\\$&')}"`));
  const norm = `hawk.1.header\n1353832234\nj4h3g2\nPOST\n/x?a=1\nexample.com\n80\n${hash}\n\n`;
  assert.match(hb, new RegExp(`mac="${createHmac('sha256', fields.key).update(norm).digest('base64').replace(/[+/=]/g, '\\$&')}"`));
  assert.match(applyAuth(req, { type: 'hawk', fields: { ...fields, app: 'a1', dlg: 'd1' } }, new Map()).request.headers[0][1], /app="a1", dlg="d1"/);
});

test('applyAuth: OAuth 1.0 — vektor RFC 5849 §1.2 (HMAC-SHA1), PLAINTEXT, RSA-SHA1, query & body', () => {
  const req: HttpRequest = { method: 'GET', url: 'http://photos.example.net/photos?file=vacation.jpg&size=original', headers: [] };
  const f = { consumer_key: 'dpf43f3p2l4k3l03', consumer_secret: 'kd94hf93k423kf44', token: 'nnch734d00sl2jdk', token_secret: 'pfkkdhi9sl3r4s00', timestamp: '137131202', nonce: 'chapoH', realm: 'Photos' };
  const h = applyAuth(req, { type: 'oauth1', fields: f }, new Map()).request.headers.find(([n]) => n === 'Authorization')![1];
  assert.equal(h, 'OAuth realm="Photos", oauth_consumer_key="dpf43f3p2l4k3l03", oauth_token="nnch734d00sl2jdk", oauth_signature_method="HMAC-SHA1", oauth_timestamp="137131202", oauth_nonce="chapoH", oauth_signature="MdpQcU8iPSUjWoN%2FUDMsK2sui9I%3D"');
  assert.equal(oauth1Signature({ ...f, signature_method: 'PLAINTEXT' }, req, {}), 'kd94hf93k423kf44&pfkkdhi9sl3r4s00');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = String(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const sig = oauth1Signature({ ...f, signature_method: 'RSA-SHA1', consumer_secret: pem }, req, { oauth_consumer_key: f.consumer_key });
  assert.ok(cryptoVerify('sha1', Buffer.from(oauth1Base(req, { oauth_consumer_key: f.consumer_key })), rsa.publicKey, Buffer.from(sig, 'base64')));
  const q = applyAuth(req, { type: 'oauth1', fields: { ...f, add_to: 'query' } }, new Map()).request;
  assert.equal(new URL(q.url).searchParams.get('oauth_signature'), 'MdpQcU8iPSUjWoN/UDMsK2sui9I=');
  assert.deepEqual(q.headers, []);
  const form: HttpRequest = { method: 'POST', url: 'http://h/p', headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: 'a=1' };
  const b = applyAuth(form, { type: 'oauth1', fields: { ...f, add_to: 'body' } }, new Map()).request;
  assert.match(String(b.body), /^a=1&oauth_consumer_key=/);
  assert.match(String(b.body), /oauth_signature=/);
});

import { oauth1BaseString as oauth1Base } from '../../src/auth';

test('headerAuth: hanya Digest user pass / AWS yang dihitung; Basic, Bearer, skema lain dikirim apa adanya', () => {
  assert.equal(headerAuth(headers(['Authorization', 'Digest u p', true]))?.type, 'digest');
  assert.equal(headerAuth(headers(['Authorization', 'AWS a s region:r service:x', true]))?.type, 'aws');
  assert.equal(headerAuth(headers(['Authorization', 'Basic user:pa ss', true]))?.type, 'basic');
  for (const v of ['Bearer t', 'Token abc', 'Digest']) assert.equal(headerAuth(headers(['Authorization', v, true])), undefined, v);
});

test('parseAuth: Basic mentah `user:pass` / `user pass` di-encode base64 saat Send; base64 asli tetap dikenali', () => {
  assert.deepEqual(parseAuth(undefined, headers(['Authorization', 'Basic us:pa:ss', true])), { type: 'basic', fields: { username: 'us', password: 'pa:ss' } });
  assert.deepEqual(parseAuth(undefined, headers(['Authorization', 'Basic us pa ss', true])), { type: 'basic', fields: { username: 'us', password: 'pa ss' } });
  const sent = applyAuth({ method: 'GET', url: 'http://h/', headers: [['Authorization', 'Basic us:pa:ss']] }, parseAuth(undefined, headers(['Authorization', 'Basic us:pa:ss', true])), new Map());
  assert.deepEqual(sent.request.headers, [['Authorization', `Basic ${Buffer.from('us:pa:ss').toString('base64')}`]]);
  assert.equal(parseAuth(undefined, headers(['Authorization', `Basic ${Buffer.from('a:b').toString('base64')}`, true])).fields.username, 'a');
});
