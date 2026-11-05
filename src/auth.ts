import { createHash, createHmac, createPrivateKey, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import type { HttpRequest } from './http';
import type { Header } from './httpFile';

export type AuthType = 'inherit' | 'none' | 'apiKey' | 'basic' | 'bearer' | 'digest' | 'hawk' | 'jwt' | 'oauth1' | 'oauth2' | 'aws';
export type AuthConfig = { type: AuthType; fields: Readonly<Record<string, string>>; retry?: boolean };
export type AuthResult = { request: HttpRequest; generatedHeaders: string[]; sourceOption?: { name: string; value: string } };

const EMPTY_FIELDS: Readonly<Record<string, string>> = {};
const TYPE_ALIASES: Record<string, AuthType> = {
  inherit: 'inherit',
  none: 'none',
  apikey: 'apiKey',
  'api-key': 'apiKey',
  basic: 'basic',
  bearer: 'bearer',
  digest: 'digest',
  jwt: 'jwt',
  aws: 'aws',
};
const ALLOWED_FIELDS: Partial<Record<AuthType, readonly string[]>> = {
  inherit: [],
  none: [],
  apiKey: ['key', 'value', 'in'],
  basic: ['username', 'password'],
  bearer: ['token'],
  digest: ['username', 'password', 'retry', 'algorithm', 'qop', 'realm', 'nonce', 'nc', 'cnonce', 'opaque'],
  jwt: ['algorithm', 'secret', 'payload', 'header', 'add_to', 'prefix', 'secret_base64'],
  aws: ['access_key', 'secret_key', 'region', 'service', 'session_token'],
};
const REQUIRED_FIELDS: Partial<Record<AuthType, readonly string[]>> = {
  apiKey: ['key', 'value', 'in'],
  basic: ['username', 'password'],
  bearer: ['token'],
  digest: ['username', 'password'],
  jwt: ['secret'],
  aws: ['access_key', 'secret_key', 'region', 'service'],
};
const VARIABLE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function parseFields(input: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let rest = input.trim();
  while (rest) {
    const match = /^([A-Za-z][\w-]*)=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+))/.exec(rest);
    if (!match) throw new Error('Invalid auth field syntax (expected name=value)');
    const name = match[1].toLowerCase();
    if (Object.hasOwn(fields, name)) throw new Error(`Duplicate auth field: ${name}`);
    const raw = match[2] ?? match[3] ?? match[4];
    fields[name] = raw.replace(/\\(["'\\])/g, '$1');
    rest = rest.slice(match[0].length).trimStart();
  }
  return fields;
}

function validateFields(type: AuthType, fields: Readonly<Record<string, string>>): void {
  const allowed = ALLOWED_FIELDS[type];
  if (!allowed) throw new Error(`Auth type ${type} is not supported yet`);
  for (const name of Object.keys(fields)) {
    if (!allowed.includes(name)) throw new Error(`Unsupported ${type} auth field: ${name}`);
  }
  for (const name of REQUIRED_FIELDS[type] ?? []) {
    if (!fields[name]) throw new Error(`${type} auth requires ${name}`);
  }
  if (type === 'apiKey' && fields.in !== 'header' && fields.in !== 'query') {
    throw new Error('apiKey auth in must be header or query');
  }
  if (type === 'bearer' && /\s/.test(fields.token)) throw new Error('bearer auth token must not contain whitespace');
  if (type === 'apiKey' && fields.in === 'header' && !HEADER_NAME.test(fields.key)) {
    throw new Error('apiKey auth key must be a valid header name');
  }
}

function parseBasicHeader(value: string): AuthConfig {
  const encoded = /^Basic\s+(\S+)$/i.exec(value.trim())?.[1];
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error('Invalid Basic Authorization header');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('Invalid Basic Authorization header');
  }
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw new Error('Basic Authorization header is not valid UTF-8');
  const separator = decoded.indexOf(':');
  if (separator < 0) throw new Error('Basic Authorization header must contain a colon');
  return { type: 'basic', fields: { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) } };
}

export function parseAuth(value: string | undefined, headers: readonly Header[]): AuthConfig {
  if (value !== undefined) {
    const text = value.trim();
    if (!text) throw new Error('Auth metadata is empty');
    const [rawType, ...rest] = text.split(/\s+/);
    const typeName = rawType.toLowerCase();
    if (!Object.hasOwn(TYPE_ALIASES, typeName)) throw new Error(`Unsupported auth type: ${rawType}`);
    const type = TYPE_ALIASES[typeName];
    const fields = parseFields(rest.join(' '));
    validateFields(type, fields);
    return { type, fields };
  }

  const header = headers.find((item) => item.enabled && item.name.toLowerCase() === 'authorization');
  if (!header) return { type: 'inherit', fields: EMPTY_FIELDS };
  const headerValue = header.value.trim();
  if (/^Basic(?:\s|$)/i.test(headerValue)) return parseBasicHeader(headerValue);
  if (/^Bearer(?:\s|$)/i.test(headerValue) && !/^Bearer\s+\S+$/i.test(headerValue)) {
    throw new Error('Invalid Bearer Authorization header');
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(headerValue);
  if (bearer) return { type: 'bearer', fields: { token: bearer[1] } };
  const scheme = /^(\S+)/.exec(headerValue)?.[1] ?? '';
  throw new Error(scheme ? `Unsupported Authorization scheme: ${scheme}` : 'Authorization header is empty');
}

function resolve(value: string, values: ReadonlyMap<string, string>): string {
  return value.replace(VARIABLE, (_whole, name: string) => {
    const found = values.get(name);
    if (found === undefined) throw new Error(`Missing auth value: ${name}`);
    return found;
  });
}

function replaceHeader(headers: [string, string][], name: string, value: string): [string, string][] {
  return [...headers.filter(([header]) => header.toLowerCase() !== name.toLowerCase()), [name, value]];
}

export type AuthContext = { /** jam untuk SigV4 / JWT iat (test) */ now?: Date };

export function applyAuth(request: HttpRequest, config: AuthConfig, values: ReadonlyMap<string, string>, ctx: AuthContext = {}): AuthResult {
  const copy: HttpRequest = { ...request, headers: request.headers.map(([name, value]) => [name, value]) };
  const result: AuthResult = { request: copy, generatedHeaders: [] };
  validateFields(config.type, config.fields);
  if (config.type === 'inherit') return result;
  if (config.type === 'none') {
    copy.headers = copy.headers.filter(([name]) => name.toLowerCase() !== 'authorization');
    return result;
  }

  if (config.type === 'apiKey') {
    const key = config.fields.key;
    const value = resolve(config.fields.value, values);
    if (config.fields.in === 'header') {
      if (/[\r\n]/.test(value)) throw new Error('apiKey auth header value must not contain newlines');
      copy.headers = replaceHeader(copy.headers, key, value);
      result.generatedHeaders.push(key);
    } else {
      const url = new URL(copy.url);
      url.searchParams.set(key, value);
      copy.url = url.toString();
    }
    return result;
  }

  if (config.type === 'basic') {
    const credentials = `${resolve(config.fields.username, values)}:${resolve(config.fields.password, values)}`;
    copy.headers = replaceHeader(copy.headers, 'Authorization', `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`);
    result.generatedHeaders.push('Authorization');
    return result;
  }

  if (config.type === 'bearer') {
    const token = resolve(config.fields.token, values);
    if (!token) throw new Error('bearer auth requires a token');
    if (/\s/.test(token)) throw new Error('bearer auth token must not contain whitespace');
    copy.headers = replaceHeader(copy.headers, 'Authorization', `Bearer ${token}`);
    result.generatedHeaders.push('Authorization');
    return result;
  }

  if (config.type === 'digest') return result; // header dihitung setelah 401 challenge (digestAuthorization)
  if (config.type === 'jwt') return applyJwt(copy, config, values, result);
  if (config.type === 'aws') return applyAws(copy, config, values, ctx.now ?? new Date(), result);
  throw new Error(`Auth type ${config.type} is not supported yet`);
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const JWT_ALGS: Record<string, { hash: string; kind: 'hmac' | 'rsa' | 'pss' | 'ec' }> = {
  HS256: { hash: 'sha256', kind: 'hmac' }, HS384: { hash: 'sha384', kind: 'hmac' }, HS512: { hash: 'sha512', kind: 'hmac' },
  RS256: { hash: 'sha256', kind: 'rsa' }, RS384: { hash: 'sha384', kind: 'rsa' }, RS512: { hash: 'sha512', kind: 'rsa' },
  PS256: { hash: 'sha256', kind: 'pss' }, PS384: { hash: 'sha384', kind: 'pss' }, PS512: { hash: 'sha512', kind: 'pss' },
  ES256: { hash: 'sha256', kind: 'ec' }, ES384: { hash: 'sha384', kind: 'ec' }, ES512: { hash: 'sha512', kind: 'ec' },
};

function jsonField(name: string, text: string | undefined, values: ReadonlyMap<string, string>): Record<string, unknown> {
  if (!text?.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(resolve(text, values)); } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`jwt auth ${name} must be valid JSON`);
    throw e;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`jwt auth ${name} must be a JSON object`);
  return v as Record<string, unknown>;
}

function applyJwt(copy: HttpRequest, config: AuthConfig, values: ReadonlyMap<string, string>, result: AuthResult): AuthResult {
  const f = config.fields;
  const alg = f.algorithm || 'HS256';
  const spec = JWT_ALGS[alg];
  if (!spec) throw new Error(`Unsupported JWT algorithm: ${alg}`);
  const header = { alg, typ: 'JWT', ...jsonField('header', f.header, values) };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(jsonField('payload', f.payload, values)))}`;
  const secret = resolve(f.secret, values);
  let sig: Buffer;
  if (spec.kind === 'hmac') {
    sig = createHmac(spec.hash, f.secret_base64 === 'true' ? Buffer.from(secret, 'base64') : secret).update(input).digest();
  } else {
    let key: KeyObject;
    try { key = createPrivateKey(secret); } catch { throw new Error(`jwt auth ${alg} needs a PEM private key as secret`); }
    sig = cryptoSign(spec.hash, Buffer.from(input), spec.kind === 'rsa' ? key
      : spec.kind === 'pss' ? { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 * (spec.hash === 'sha256' ? 1 : spec.hash === 'sha384' ? 1.5 : 2) }
        : { key, dsaEncoding: 'ieee-p1363' });
  }
  const token = `${input}.${b64u(sig)}`;
  if (f.add_to === 'query') {
    const url = new URL(copy.url);
    url.searchParams.set('token', token); // shortcut: nama query tetap "token", belum bisa diganti
    copy.url = url.toString();
  } else {
    copy.headers = replaceHeader(copy.headers, 'Authorization', `${f.prefix ?? 'Bearer'} ${token}`);
    result.generatedHeaders.push('Authorization');
  }
  return result;
}

const sha256 = (x: string | Buffer): string => createHash('sha256').update(x).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const rfc3986 = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function applyAws(copy: HttpRequest, config: AuthConfig, values: ReadonlyMap<string, string>, now: Date, result: AuthResult): AuthResult {
  const f = config.fields;
  const access = resolve(f.access_key, values), secret = resolve(f.secret_key, values);
  const region = resolve(f.region, values), service = resolve(f.service, values);
  const token = f.session_token ? resolve(f.session_token, values) : undefined;
  const url = new URL(copy.url);
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: [string, string][] = [['host', url.host], ['x-amz-date', amzDate], ...(token ? [['x-amz-security-token', token] as [string, string]] : [])];
  const query = [...url.searchParams].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const path = service === 's3' ? url.pathname : url.pathname.split('/').map((seg) => rfc3986(seg)).join('/'); // non-S3: segmen di-encode dua kali
  const signed = headers.map(([n]) => n).join(';');
  const body = copy.body ?? '';
  const canonicalRequest = `${copy.method.toUpperCase()}\n${path || '/'}\n${query}\n${headers.map(([n, v]) => `${n}:${v.trim()}\n`).join('')}\n${signed}\n${sha256(body)}`;
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  copy.headers = [...copy.headers.filter(([n]) => !['authorization', 'x-amz-date', 'x-amz-security-token'].includes(n.toLowerCase())),
    ['x-amz-date', amzDate], ...(token ? [['x-amz-security-token', token] as [string, string]] : []),
    ['Authorization', `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signed}, Signature=${signature}`]];
  result.generatedHeaders.push('x-amz-date', 'Authorization');
  return result;
}

export type DigestChallenge = { realm?: string; nonce?: string; opaque?: string; qop?: string; algorithm?: string };

/** `WWW-Authenticate: Digest realm="…", nonce="…", qop="auth,auth-int", algorithm=SHA-256` -> field; undefined bila bukan Digest */
export function parseDigestChallenge(header: string): DigestChallenge {
  const m = /^\s*Digest\s+(.*)$/is.exec(header);
  if (!m) throw new Error('Not a Digest challenge');
  const out: Record<string, string> = {};
  for (const p of m[1].matchAll(/([A-Za-z][\w-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s,]*))/g)) out[p[1].toLowerCase()] = (p[2] ?? p[3]).replace(/\\(.)/g, '$1');
  return out;
}

const DIGEST_HASH: Record<string, string> = { md5: 'md5', sha1: 'sha1', 'sha-256': 'sha256', 'sha-512-256': 'sha512-256' };

/** header Authorization Digest (RFC 7616: MD5, SHA-256, SHA-512-256, tiap -sess; qop auth / auth-int) untuk request yang ditantang `challenge` */
export function digestAuthorization(config: AuthConfig, request: HttpRequest, challenge: DigestChallenge): string {
  const f = config.fields;
  const algorithm = f.algorithm || challenge.algorithm || 'MD5';
  const m = /^(.*?)(-sess)?$/i.exec(algorithm)!;
  const hashName = DIGEST_HASH[m[1].toLowerCase()];
  if (!hashName) throw new Error(`Unsupported Digest algorithm: ${algorithm}`);
  const H = (x: string | Buffer) => createHash(hashName).update(x).digest('hex');
  const realm = f.realm || challenge.realm || '';
  const nonce = f.nonce || challenge.nonce || '';
  const offered = (f.qop || challenge.qop || '').split(',').map((x) => x.trim()).filter(Boolean);
  const qop = offered.includes('auth') ? 'auth' : offered.includes('auth-int') ? 'auth-int' : undefined; // qop lain tidak dikenal: pakai mode lama
  const nc = f.nc || '00000001';
  const cnonce = f.cnonce || randomBytes(8).toString('hex');
  const url = new URL(request.url);
  const uri = `${url.pathname}${url.search}`;
  let ha1 = H(`${f.username}:${realm}:${f.password}`);
  if (m[2]) ha1 = H(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = H(qop === 'auth-int' ? `${request.method.toUpperCase()}:${uri}:${H(request.body ?? '')}` : `${request.method.toUpperCase()}:${uri}`);
  const response = qop ? H(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${nonce}:${ha2}`);
  const q = (v: string) => `"${v.replace(/["\\]/g, '\\$&')}"`;
  const parts = [`username=${q(f.username)}`, `realm=${q(realm)}`, `nonce=${q(nonce)}`, `uri=${q(uri)}`,
    ...(algorithm !== 'MD5' || f.algorithm ? [`algorithm=${algorithm}`] : []),
    ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce=${q(cnonce)}`] : []), `response=${q(response)}`,
    ...(challenge.opaque ? [`opaque=${q(challenge.opaque)}`] : [])];
  return `Digest ${parts.join(', ')}`;
}

/** kirim; bila 401 + challenge Digest (dan retry tidak dimatikan) hitung header lalu kirim ulang sekali. `discard` membuang response 401 (mis. file body) */
export async function sendWithDigest<Q extends HttpRequest, R extends { status: number; headers: [string, string][] }>(
  config: AuthConfig | undefined, request: Q, sendOnce: (r: Q) => Promise<R>, discard: (res: R) => Promise<void> = async () => undefined,
): Promise<R> {
  const res = await sendOnce(request);
  if (config?.type !== 'digest' || config.fields.retry === 'false' || res.status !== 401) return res;
  const challenge = res.headers.find(([k, v]) => k.toLowerCase() === 'www-authenticate' && /^\s*Digest\b/i.test(v))?.[1];
  if (!challenge) return res;
  await discard(res);
  const header = digestAuthorization(config, request, parseDigestChallenge(challenge));
  return sendOnce({ ...request, headers: [...request.headers.filter(([n]) => n.toLowerCase() !== 'authorization'), ['Authorization', header]] });
}
