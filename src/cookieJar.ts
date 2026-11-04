// cookie jar (tanpa vscode, tanpa library): parse Set-Cookie, cocokkan Domain / Path / Secure / Expires / Max-Age (RFC 6265 inti),
// simpan per Environment + domain sebagai chunk cache (0600). Jam di-inject supaya bisa di-test.
import { readChunks, remove, writeChunk } from './cache';

export type Cookie = {
  name: string; value: string; domain: string; /** tanpa atribut Domain: hanya host itu */ hostOnly: boolean; path: string;
  secure: boolean; httpOnly: boolean; /** ms epoch; tanpa = cookie session (tetap disimpan sampai dihapus) */ expires?: number;
  sameSite?: string; created: number;
};

/** path default: path URL sampai '/' terakhir (tanpa '/' itu), minimal '/' */
function defaultPath(url: URL): string {
  const p = url.pathname;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
export const domainMatch = (host: string, domain: string, hostOnly: boolean): boolean =>
  host === domain || (!hostOnly && host.endsWith(`.${domain}`) && !/^\d+\.\d+\.\d+\.\d+$/.test(host));
export function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/');
}

/** satu header Set-Cookie; undefined = tidak valid / Domain bukan milik host ini */
export function parseSetCookie(header: string, url: URL, now: number): Cookie | undefined {
  const [pair, ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return undefined;
  const name = pair.slice(0, eq).trim();
  if (!name) return undefined;
  const host = url.hostname.toLowerCase();
  const c: Cookie = { name, value: pair.slice(eq + 1).trim(), domain: host, hostOnly: true, path: defaultPath(url), secure: false, httpOnly: false, created: now };
  let maxAge: number | undefined;
  for (const a of attrs) {
    const i = a.indexOf('=');
    const key = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : a.slice(i + 1).trim();
    if (key === 'domain' && val) {
      const d = val.replace(/^\./, '').toLowerCase();
      if (!domainMatch(host, d, false)) return undefined;
      c.domain = d;
      c.hostOnly = false;
    } else if (key === 'path' && val.startsWith('/')) c.path = val;
    else if (key === 'secure') c.secure = true;
    else if (key === 'httponly') c.httpOnly = true;
    else if (key === 'samesite' && val) c.sameSite = val;
    else if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = Number(val);
    else if (key === 'expires') { const t = Date.parse(val); if (!Number.isNaN(t)) c.expires = t; }
  }
  if (maxAge !== undefined) c.expires = now + maxAge * 1000; // Max-Age menang atas Expires
  return c;
}

const same = (a: Cookie, b: Cookie) => a.name === b.name && a.domain === b.domain && a.path === b.path;
const alive = (c: Cookie, now: number) => c.expires === undefined || c.expires > now;

/** simpan Set-Cookie dari response (header terpisah per cookie, bukan digabung koma) */
export function storeCookies(jar: readonly Cookie[], setCookies: readonly string[], url: URL, now: number): Cookie[] {
  let out = jar.filter((c) => alive(c, now));
  for (const h of setCookies) {
    const c = parseSetCookie(h, url, now);
    if (!c) continue;
    out = out.filter((x) => !same(x, c));
    if (alive(c, now)) out.push(c); // Max-Age=0 / Expires lampau = hapus
  }
  return out;
}

/** header Cookie untuk URL: path lebih panjang dulu, lalu yang lebih dulu dibuat */
export function cookieHeader(jar: readonly Cookie[], url: URL, now: number): string | undefined {
  const host = url.hostname.toLowerCase();
  const list = jar.filter((c) => alive(c, now) && domainMatch(host, c.domain, c.hostOnly) && pathMatch(url.pathname || '/', c.path) && (!c.secure || url.protocol === 'https:'))
    .map((c, i) => ({ c, i })).sort((a, b) => b.c.path.length - a.c.path.length || a.i - b.i).map((x) => `${x.c.name}=${x.c.value}`);
  return list.length ? list.join('; ') : undefined;
}

/** paste dari browser: "Cookie: a=1; b=2", "a=1; b=2", "JSESSIONID=x" atau baris "Set-Cookie: …" */
export function parseCookiePaste(text: string, domain: string, now: number): Cookie[] {
  const out: Cookie[] = [];
  const url = new URL(`http://${domain}/`);
  for (const raw of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const set = /^set-cookie\s*:\s*/i.exec(raw);
    if (set) { const c = parseSetCookie(raw.slice(set[0].length), url, now); if (c) out.push({ ...c, path: /;\s*path=/i.test(raw) ? c.path : '/' }); continue; }
    for (const part of raw.replace(/^cookie\s*:\s*/i, '').split(';')) {
      const eq = part.indexOf('=');
      const name = eq > 0 ? part.slice(0, eq).trim() : '';
      if (!name || /\s/.test(name)) continue;
      out.push({ name, value: part.slice(eq + 1).trim(), domain, hostOnly: true, path: '/', secure: false, httpOnly: false, created: now });
    }
  }
  return out;
}

/** nilai semua cookie (di-mask di log) */
export const jarCookieValues = (jar: readonly Cookie[]): string[] => jar.map((c) => c.value).filter((v) => v.length >= 2);

// ---------- penyimpanan: chunk `<env>|<domain>` ----------
const key = (env: string, domain: string) => `${env}|${domain}`;

export async function loadJar(dir: string, env: string): Promise<Cookie[]> {
  return (await readChunks<Cookie[]>(dir)).filter(([k]) => k.startsWith(`${env}|`)).flatMap(([, v]) => (Array.isArray(v) ? v : []));
}

/** tulis jar Environment: satu chunk per domain, domain tanpa cookie dihapus */
export async function saveJar(dir: string, env: string, jar: readonly Cookie[]): Promise<void> {
  const byDomain = new Map<string, Cookie[]>();
  for (const c of jar) byDomain.set(c.domain, [...(byDomain.get(c.domain) ?? []), c]);
  for (const [domain, list] of byDomain) await writeChunk(dir, key(env, domain), list);
  for (const [k] of await readChunks(dir)) {
    if (k.startsWith(`${env}|`) && !byDomain.has(k.slice(env.length + 1))) await remove(dir, k);
  }
}
