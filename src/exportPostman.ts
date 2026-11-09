// export collection http.me -> Postman Collection v2.1 / Environment / Globals (Fase 5c), kebalikan postman.ts; tanpa vscode
import { parseAuth } from './auth';
import type { EnvVar } from './environments';
import type { Header, Param, ParsedRequest } from './httpFile';
import type { ExportCollection, ExportFolder, ExportRequest } from './exportModel';
import { untranslateScript } from './postmanScript';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dokumen Postman bebas bentuk
type Obj = Record<string, any>;
export type PostmanItem = Obj & { name: string; item?: PostmanItem[]; request?: Obj; auth?: Obj; event?: Obj[] };
export type PostmanCollection = { info: { name: string; schema: string }; item: PostmanItem[]; variable?: Obj[]; auth?: Obj; event?: Obj[] };

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const BOUNDARY_RE = /boundary=("?)([^";\s]+)\1/i;
const LANG: [RegExp, string][] = [[/[/+]json\b/, 'json'], [/[/+]xml\b/, 'xml'], [/text\/html/, 'html'], [/javascript/, 'javascript']];

// kebalikan pick() di postman.ts: [tipe Postman, {kunci http.me: kunci Postman}]
const AUTH_MAP: Record<string, [string, Record<string, string>]> = {
  bearer: ['bearer', { token: 'token' }],
  basic: ['basic', { username: 'username', password: 'password' }],
  apiKey: ['apikey', { key: 'key', value: 'value', in: 'in' }],
  digest: ['digest', { username: 'username', password: 'password', realm: 'realm', nonce: 'nonce', algorithm: 'algorithm', qop: 'qop', opaque: 'opaque' }],
  hawk: ['hawk', { id: 'authId', key: 'authKey', algorithm: 'algorithm', user: 'user', nonce: 'nonce', ext: 'extraData', app: 'app', dlg: 'delegation', timestamp: 'timestamp' }],
  aws: ['awsv4', { access_key: 'accessKey', secret_key: 'secretKey', region: 'region', service: 'service', session_token: 'sessionToken' }],
  jwt: ['jwt', { algorithm: 'algorithm', secret: 'secret', payload: 'payload' }],
  oauth1: ['oauth1', { consumer_key: 'consumerKey', consumer_secret: 'consumerSecret', token: 'token', token_secret: 'tokenSecret', signature_method: 'signatureMethod', version: 'version', realm: 'realm', nonce: 'nonce', timestamp: 'timestamp', callback: 'callback', verifier: 'verifier' }],
  oauth2: ['oauth2', { token_url: 'accessTokenUrl', authorization_url: 'authUrl', client_id: 'clientId', client_secret: 'clientSecret', username: 'username', password: 'password', scope: 'scope', redirect_uri: 'redirect_uri' }],
};
const GRANT_OUT: Record<string, string> = { authorization_code: 'authorization_code', client_credentials: 'client_credentials', password: 'password_credentials', implicit: 'implicit' };

/** teks setelah `# @auth` -> objek auth Postman; undefined = inherit */
export function toPostmanAuth(text: string | undefined, where: string, warnings: string[]): Obj | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  try {
    const a = parseAuth(text, []);
    if (a.type === 'none') return { type: 'noauth' };
    const m = AUTH_MAP[a.type];
    if (!m) return undefined;
    const rows = Object.entries(m[1]).filter(([k]) => a.fields[k] !== undefined && a.fields[k] !== '').map(([k, to]) => ({ key: to, value: a.fields[k], type: 'string' }));
    if (a.type === 'oauth2' && a.fields.grant) rows.push({ key: 'grant_type', value: GRANT_OUT[a.fields.grant] ?? a.fields.grant, type: 'string' });
    if (a.type === 'jwt' && a.fields.secret_base64 === 'true') rows.push({ key: 'isSecretBase64Encoded', value: 'true', type: 'string' });
    return { type: m[0], [m[0]]: rows };
  } catch (e) {
    warnings.push(`${where}: authorization skipped (${(e as Error).message})`); // peringatan dalam laporan export, bukan error handler yang menelan
    return undefined;
  }
}

function splitUrl(url: string, disabled: readonly Param[]): Obj {
  let rest = url;
  let hash: string | undefined;
  const h = rest.indexOf('#');
  if (h >= 0) { hash = rest.slice(h + 1); rest = rest.slice(0, h); }
  let q: string | undefined;
  const qi = rest.indexOf('?');
  if (qi >= 0) { q = rest.slice(qi + 1); rest = rest.slice(0, qi); }
  const pm = /^([a-z][\w+.-]*):\/\/(.*)$/i.exec(rest);
  if (pm) rest = pm[2];
  const slash = rest.indexOf('/');
  let hostPart = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '' : rest.slice(slash + 1);
  const port = /^(.*[^}]):(\d+)$/.exec(hostPart);
  if (port) hostPart = port[1];
  const query = [
    ...(q ? q.split('&').filter(Boolean).map((p) => { const eq = p.indexOf('='); return eq < 0 ? { key: p } : { key: p.slice(0, eq), value: p.slice(eq + 1) }; }) : []),
    ...disabled.map((p) => ({ key: p.key, value: p.value, disabled: true })),
  ];
  return {
    raw: url, ...(pm ? { protocol: pm[1] } : {}), host: hostPart.includes('{{') ? [hostPart] : hostPart.split('.'), ...(port ? { port: port[2] } : {}),
    ...(path ? { path: path.split('/') } : {}), ...(query.length ? { query } : {}), ...(hash ? { hash } : {}),
  };
}

const dec = (s: string) => s.split(/(\{\{[^}]*\}\})/).map((p, i) => { if (i % 2) return p; try { return decodeURIComponent(p); } catch { return p; } }).join(''); // %-rusak: pakai apa adanya

export function multipart(body: string, boundary: string): Obj[] | undefined {
  const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = body.replace(/\r\n/g, '\n').split(new RegExp(`(?:^|\\n)--${esc}(?:--)?(?=\\n|$)`)).slice(1, -1);
  const rows: Obj[] = [];
  for (const raw of parts) {
    const p = raw.replace(/^\n/, '');
    const cut = p.indexOf('\n\n');
    const head = cut < 0 ? p : p.slice(0, cut);
    const value = cut < 0 ? '' : p.slice(cut + 2);
    const name = /\bname="([^"]*)"/.exec(head)?.[1];
    if (name === undefined) return undefined;
    const file = /\bfilename="/.test(head) ? /^<\s*(.+)$/.exec(value.trim())?.[1] : undefined;
    const ct = /^Content-Type:\s*(.+)$/im.exec(head)?.[1];
    rows.push(file ? { key: name, type: 'file', src: file } : { key: name, value, type: 'text', ...(ct ? { contentType: ct } : {}) });
  }
  return rows;
}

function bodyOf(r: ParsedRequest): Obj | undefined {
  if (r.bodyFile) return { mode: 'file', file: { src: r.bodyFile } };
  if (r.body === '') return undefined;
  const ct = r.headers.find((h) => h.enabled && h.name.toLowerCase() === 'content-type')?.value ?? '';
  const b = BOUNDARY_RE.exec(ct);
  if (/multipart\/form-data/i.test(ct) && b) {
    const rows = multipart(r.body, b[2]);
    if (rows) return { mode: 'formdata', formdata: rows };
  }
  if (/application\/x-www-form-urlencoded/i.test(ct)) {
    return { mode: 'urlencoded', urlencoded: r.body.split('&').filter(Boolean).map((p) => { const eq = p.indexOf('='); return { key: dec(eq < 0 ? p : p.slice(0, eq)), value: eq < 0 ? '' : dec(p.slice(eq + 1)) }; }) };
  }
  const lang = LANG.find(([re]) => re.test(ct))?.[1];
  return { mode: 'raw', raw: r.body, ...(lang ? { options: { raw: { language: lang } } } : {}) };
}

const events = (pre: string, post: string, o: { translateScripts: boolean }, where: string, warnings: string[]): Obj[] =>
  ([['prerequest', pre], ['test', post]] as const).filter(([, s]) => s.trim() !== '').map(([listen, src]) => {
    const t = o.translateScripts ? untranslateScript(src) : { code: src, warnings: [] };
    warnings.push(...t.warnings.map((w) => `${where}: ${w}`));
    return { listen, script: { type: 'text/javascript', exec: t.code.split('\n') } };
  });

function requestItem(x: ExportRequest, path: string, o: { translateScripts: boolean }, warnings: string[]): PostmanItem {
  const r = x.req;
  const header = r.headers.map((h: Header) => ({ key: h.name, value: h.value, ...(h.enabled ? {} : { disabled: true }) }));
  const desc = r.preamble.map((l) => l.replace(/^(#|\/\/)\s?/, '')).join('\n');
  const auth = toPostmanAuth(r.auth, path, warnings);
  const body = bodyOf(r);
  const ev = events(x.pre, x.post, o, path, warnings);
  return {
    name: x.name,
    request: { method: r.method, header, url: splitUrl(r.url, r.disabledParams), ...(body ? { body } : {}), ...(auth ? { auth } : {}), ...(desc ? { description: desc } : {}) },
    ...(ev.length ? { event: ev } : {}),
    ...(r.followRedirects ? {} : { protocolProfileBehavior: { followRedirects: false } }),
  };
}

function folderItem(f: ExportFolder, path: string, o: { translateScripts: boolean }, warnings: string[], count: { n: number }): PostmanItem {
  const auth = toPostmanAuth(f.auth, path, warnings);
  const ev = events(f.pre, f.post, o, path, warnings);
  return {
    name: f.name,
    item: f.items.map((i) => {
      if (i.kind === 'folder') return folderItem(i, `${path}/${i.name}`, o, warnings, count);
      count.n++;
      return requestItem(i, `${path}/${i.name}`, o, warnings);
    }),
    ...(auth ? { auth } : {}), ...(ev.length ? { event: ev } : {}),
  };
}

export function toPostman(c: ExportCollection, o: { translateScripts: boolean }): { collection: PostmanCollection; warnings: string[]; requests: number } {
  const warnings = [...c.warnings];
  const count = { n: 0 };
  const top = folderItem(c, c.name, o, warnings, count);
  const auth = top.auth;
  const collection: PostmanCollection = {
    info: { name: c.name, schema: SCHEMA }, item: top.item!,
    ...(c.vars.length ? { variable: c.vars.map((v) => ({ key: v.key, value: v.value ?? '' })) } : {}),
    ...(auth ? { auth } : {}), ...(top.event ? { event: top.event } : {}),
  };
  return { collection, warnings, requests: count.n };
}

export function validatePostman(c: PostmanCollection): string[] {
  const errors: string[] = [];
  if (!c.info?.name || !c.info.schema?.includes('getpostman.com/json/collection/v2.1')) errors.push('info.name / info.schema are required (Collection v2.1)');
  const walk = (items: PostmanItem[], path: string) => {
    for (const i of items) {
      if (!i.name) errors.push(`${path}: an item has no name`);
      if (Array.isArray(i.item)) walk(i.item, `${path}/${i.name}`);
      else if (!i.request?.method || !i.request.url) errors.push(`${path}/${i.name}: request needs method and url`);
    }
  };
  walk(Array.isArray(c.item) ? c.item : [], c.info?.name ?? '');
  return errors;
}

export function toPostmanEnvironment(name: string, vars: readonly EnvVar[], secrets: Readonly<Record<string, string>>, o: { scope: 'environment' | 'globals'; includeSecrets: boolean }): { id?: string; name: string; values: Obj[]; _postman_variable_scope: string; _postman_exported_using: string } {
  return {
    name, _postman_variable_scope: o.scope, _postman_exported_using: 'http.me',
    values: vars.map((v) => ({
      key: v.key, value: v.secret ? (o.includeSecrets ? secrets[v.key] ?? '' : '') : v.value ?? '',
      type: v.secret ? 'secret' : 'default', enabled: v.enabled !== false,
    })),
  };
}
