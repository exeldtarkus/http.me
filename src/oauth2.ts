// OAuth 2.0 (tanpa vscode): Client Credentials, Password, Authorization Code + PKCE, Implicit, Refresh. Token disimpan lewat deps (SecretStorage per Environment)
import { createHash, randomBytes } from 'node:crypto';
import type { HttpRequest } from './http';

export type OAuthToken = { access_token: string; token_type?: string; refresh_token?: string; /** epoch ms */ expires_at?: number; scope?: string };
export type OAuthFields = Readonly<Record<string, string | undefined>>;
export type OAuthDeps = {
  now(): number;
  send(request: HttpRequest): Promise<{ status: number; body: string }>;
  load(): Promise<OAuthToken | undefined>;
  save(token: OAuthToken | undefined): Promise<void>;
  /** buka browser ke `url`, kembalikan URL redirect lengkap (code / token ada di dalamnya); tanpa ini grant yang butuh browser ditolak */
  authorize?(url: string): Promise<string>;
  /** dipanggil tepat sebelum browser dibuka: siapkan penangkap redirect (loopback), kembalikan redirect_uri yang dipakai */
  listen?(redirectUri: string | undefined): Promise<string>;
};

/** token dianggap habis 30 dtk sebelum expires_at */
const SKEW_MS = 30_000;
const valid = (t: OAuthToken, now: number): boolean => t.expires_at === undefined || t.expires_at - now > SKEW_MS;

/** kunci penyimpanan token: konfigurasi yang membedakan token (tanpa secret) */
export const tokenKey = (f: OAuthFields): string =>
  createHash('sha256').update(JSON.stringify([f.grant, f.token_url, f.authorization_url, f.client_id, f.scope, f.username, f.redirect_uri])).digest('hex').slice(0, 32);

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(f: OAuthFields, responseType: 'code' | 'token', state: string, challenge?: string): string {
  const url = new URL(f.authorization_url ?? '');
  url.searchParams.set('response_type', responseType);
  url.searchParams.set('client_id', f.client_id ?? '');
  if (f.redirect_uri) url.searchParams.set('redirect_uri', f.redirect_uri);
  if (f.scope) url.searchParams.set('scope', f.scope);
  url.searchParams.set('state', state);
  if (challenge) { url.searchParams.set('code_challenge', challenge); url.searchParams.set('code_challenge_method', 'S256'); }
  return url.toString();
}

/** query + fragment URL redirect -> objek (fragment menang) */
export function parseRedirect(redirect: string): Record<string, string> {
  const url = new URL(redirect);
  return { ...Object.fromEntries(url.searchParams), ...Object.fromEntries(new URLSearchParams(url.hash.replace(/^#/, ''))) };
}

const need = (f: OAuthFields, name: string): string => {
  const v = f[name];
  if (!v) throw new Error(`OAuth 2.0 needs ${name}`);
  return v;
};

function toToken(json: Record<string, unknown>, now: number, previous?: OAuthToken): OAuthToken {
  if (typeof json.access_token !== 'string' || !json.access_token) throw new Error('OAuth 2.0 response has no access_token');
  const ttl = Number(json.expires_in);
  return {
    access_token: json.access_token,
    ...(typeof json.token_type === 'string' ? { token_type: json.token_type } : {}),
    ...(typeof json.refresh_token === 'string' ? { refresh_token: json.refresh_token } : previous?.refresh_token ? { refresh_token: previous.refresh_token } : {}),
    ...(Number.isFinite(ttl) && ttl > 0 ? { expires_at: now + ttl * 1000 } : {}),
    ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
  };
}

/** POST ke token endpoint; client_secret -> Basic header, kalau tidak client_id di body. Pesan error memakai error / error_description server, tanpa request */
async function tokenRequest(f: OAuthFields, params: Record<string, string>, deps: OAuthDeps, previous?: OAuthToken): Promise<OAuthToken> {
  const body = new URLSearchParams(params);
  const headers: [string, string][] = [['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', 'application/json']];
  if (f.client_secret) headers.push(['Authorization', `Basic ${Buffer.from(`${encodeURIComponent(f.client_id ?? '')}:${encodeURIComponent(f.client_secret)}`).toString('base64')}`]);
  else if (f.client_id) body.set('client_id', f.client_id);
  const res = await deps.send({ method: 'POST', url: need(f, 'token_url'), headers, body: body.toString() });
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(res.body) as Record<string, unknown>; } catch { json = {}; } // bukan JSON: ditangani lewat status / potongan teks di bawah
  if (res.status < 200 || res.status >= 300) {
    const why = [json.error, json.error_description].filter((x) => typeof x === 'string').join(': ') || res.body.slice(0, 200);
    throw new Error(`OAuth 2.0 token request failed (${res.status}): ${why}`);
  }
  return toToken(json, deps.now(), previous);
}

async function viaBrowser(f: OAuthFields, deps: OAuthDeps, type: 'code' | 'token'): Promise<Record<string, string>> {
  if (!deps.authorize) throw new Error('This OAuth 2.0 grant needs a browser: use Get New Access Token in the Authorization tab.');
  need(f, 'authorization_url');
  const redirect = deps.listen ? await deps.listen(f.redirect_uri) : f.redirect_uri;
  f = { ...f, ...(redirect ? { redirect_uri: redirect } : {}) };
  const state = randomBytes(12).toString('hex');
  const pkce = type === 'code' ? (f.code_verifier ? { verifier: f.code_verifier, challenge: createHash('sha256').update(f.code_verifier).digest('base64url') } : pkcePair()) : undefined;
  const back = parseRedirect(await deps.authorize(authorizeUrl(f, type, state, pkce?.challenge)));
  if (back.error) throw new Error(`OAuth 2.0 authorization failed: ${[back.error, back.error_description].filter(Boolean).join(': ')}`);
  if (back.state !== state) throw new Error('OAuth 2.0 state mismatch: the redirect does not belong to this request');
  return { ...back, ...(pkce ? { code_verifier: pkce.verifier } : {}), ...(redirect ? { redirect_uri: redirect } : {}) };
}

/** token berlaku (pakai ulang / refresh otomatis) atau ambil baru sesuai grant; hasilnya disimpan lewat deps.save */
export async function accessToken(f: OAuthFields, deps: OAuthDeps, force = false): Promise<OAuthToken> {
  const stored = force ? undefined : await deps.load();
  if (stored && valid(stored, deps.now())) return stored;
  const grant = f.grant || 'client_credentials';
  const scope: Record<string, string> = f.scope ? { scope: f.scope } : {};
  const refresh = stored?.refresh_token ?? (grant === 'refresh_token' ? f.refresh_token : undefined);
  if (refresh) {
    try {
      const t = await tokenRequest(f, { grant_type: 'refresh_token', refresh_token: refresh, ...scope }, deps, stored);
      await deps.save(t);
      return t;
    } catch {
      // refresh ditolak (kedaluwarsa / dicabut): lanjut ke grant penuh di bawah; kegagalan grant itu yang dilaporkan
    }
  }
  let token: OAuthToken;
  if (grant === 'client_credentials') token = await tokenRequest(f, { grant_type: 'client_credentials', ...scope }, deps);
  else if (grant === 'password') token = await tokenRequest(f, { grant_type: 'password', username: need(f, 'username'), password: need(f, 'password'), ...scope }, deps);
  else if (grant === 'authorization_code') {
    const back = await viaBrowser(f, deps, 'code');
    if (!back.code) throw new Error('OAuth 2.0 redirect has no code');
    token = await tokenRequest(f, { grant_type: 'authorization_code', code: back.code, ...(back.code_verifier ? { code_verifier: back.code_verifier } : {}), ...(back.redirect_uri ? { redirect_uri: back.redirect_uri } : {}) }, deps);
  } else if (grant === 'implicit') {
    const back = await viaBrowser(f, deps, 'token');
    token = toToken(back, deps.now());
  } else if (grant === 'refresh_token') throw new Error('OAuth 2.0 refresh_token grant needs a valid refresh_token');
  else throw new Error(`Unsupported OAuth 2.0 grant: ${grant}`);
  await deps.save(token);
  return token;
}
