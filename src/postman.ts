// Postman Collection v2.0 / v2.1 -> folder + file .http (tanpa vscode); Environment / Globals ada di environments.ts
import { emptyRequest, METHODS, serializeRequest, type Header, type ParsedRequest } from './httpFile';
import { serializeEnvironment, type EnvVar } from './environments';
import { authText, safeName, uniqueNamer, type ImportFile, type ImportPlan } from './importCommon';
import { translateScript } from './postmanScript';
import { DYNAMIC_NAMES } from './vars';

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): string => (x === undefined || x === null ? '' : String(x));
const arr = (x: unknown): Obj[] => (Array.isArray(x) ? x.filter(isObj) : []);

/** field auth Postman: array [{key,value}] (v2.1) atau objek {key:value} (v2.0) */
function fieldsOf(auth: Obj, type: string): Record<string, string> {
  const v = auth[type];
  if (Array.isArray(v)) return Object.fromEntries(arr(v).map((x) => [str(x.key), str(x.value)]));
  return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)])) : {};
}
const pick = (src: Record<string, string>, map: Record<string, string>, need: Record<string, string> = {}): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [to, from] of Object.entries(map)) out[to] = src[from] || need[to] || '';
  return out;
};
const GRANTS: Record<string, string> = { authorization_code: 'authorization_code', authorization_code_with_pkce: 'authorization_code', client_credentials: 'client_credentials', password_credentials: 'password', password: 'password', implicit: 'implicit' };

/** Postman auth -> teks setelah `# @auth`; undefined = tidak ada baris (inherit / tidak didukung, alasan di warning) */
export function postmanAuth(auth: unknown): { auth?: string; warning?: string } {
  if (!isObj(auth) || typeof auth.type !== 'string') return {};
  const t = auth.type;
  const f = fieldsOf(auth, t);
  switch (t) {
    case 'noauth': return { auth: 'none' };
    case 'bearer': return { auth: authText('bearer', pick(f, { token: 'token' }, { token: '{{token}}' })) };
    case 'basic': return { auth: authText('basic', pick(f, { username: 'username', password: 'password' }, { username: '{{username}}', password: '{{password}}' })) };
    case 'apikey': return { auth: authText('apiKey', pick(f, { key: 'key', value: 'value', in: 'in' }, { key: 'X-API-Key', value: '{{apiKey}}', in: 'header' })) };
    case 'digest': return { auth: authText('digest', pick(f, { username: 'username', password: 'password', realm: 'realm', nonce: 'nonce', algorithm: 'algorithm', qop: 'qop', opaque: 'opaque' }, { username: '{{username}}', password: '{{password}}' })) };
    case 'hawk': return { auth: authText('hawk', pick(f, { id: 'authId', key: 'authKey', algorithm: 'algorithm', user: 'user', nonce: 'nonce', ext: 'extraData', app: 'app', dlg: 'delegation', timestamp: 'timestamp' }, { id: '{{hawkId}}', key: '{{hawkKey}}' })) };
    case 'awsv4': return { auth: authText('aws', pick(f, { access_key: 'accessKey', secret_key: 'secretKey', region: 'region', service: 'service', session_token: 'sessionToken' }, { access_key: '{{awsAccessKey}}', secret_key: '{{awsSecretKey}}', region: '{{awsRegion}}', service: '{{awsService}}' })) };
    case 'jwt': return { auth: authText('jwt', { ...pick(f, { algorithm: 'algorithm', secret: 'secret', payload: 'payload' }, { secret: '{{jwtSecret}}' }), ...(f.isSecretBase64Encoded === 'true' ? { secret_base64: 'true' } : {}) }) };
    case 'oauth1': return { auth: authText('oauth1', pick(f, { consumer_key: 'consumerKey', consumer_secret: 'consumerSecret', token: 'token', token_secret: 'tokenSecret', signature_method: 'signatureMethod', version: 'version', realm: 'realm', nonce: 'nonce', timestamp: 'timestamp', callback: 'callback', verifier: 'verifier' }, { consumer_key: '{{consumerKey}}' })) };
    case 'oauth2': {
      const grant = GRANTS[f.grant_type] ?? '';
      return { auth: authText('oauth2', { grant, ...pick(f, { token_url: 'accessTokenUrl', authorization_url: 'authUrl', client_id: 'clientId', client_secret: 'clientSecret', username: 'username', password: 'password', scope: 'scope', redirect_uri: 'redirect_uri' }) }) };
    }
    default: return { warning: `Authorization type "${t}" is not supported and was skipped` };
  }
}

const enc = (s: string) => s.split(/(\{\{[^}]*\}\})/).map((p, i) => (i % 2 ? p : encodeURIComponent(p))).join('');

function urlOf(u: unknown): { url: string; disabled: { key: string; value: string }[] } {
  if (typeof u === 'string') return { url: u, disabled: [] };
  if (!isObj(u)) return { url: '', disabled: [] };
  const host = Array.isArray(u.host) ? u.host.map(str).join('.') : str(u.host);
  const query = arr(u.query);
  const disabled = query.filter((q) => q.disabled === true).map((q) => ({ key: str(q.key), value: str(q.value) }));
  if (!host) return { url: str(u.raw), disabled };
  const vars = new Map(arr(u.variable).map((v) => [str(v.key), str(v.value)]));
  const path = (Array.isArray(u.path) ? u.path : [u.path]).filter((p) => p !== undefined && p !== '').map((p) => (isObj(p) ? str(p.value) : str(p)))
    .map((p) => (p.startsWith(':') ? vars.get(p.slice(1)) || `{{${p.slice(1)}}}` : p));
  const q = query.filter((x) => x.disabled !== true).map((x) => (x.value === undefined || x.value === null ? str(x.key) : `${str(x.key)}=${str(x.value)}`));
  return { url: `${u.protocol ? `${str(u.protocol)}://` : ''}${host}${u.port ? `:${str(u.port)}` : ''}${path.length ? `/${path.join('/')}` : ''}${q.length ? `?${q.join('&')}` : ''}${u.hash ? `#${str(u.hash)}` : ''}`, disabled };
}
// path variable `:id` di URL string
const colonVars = (url: string, vars: Obj[]): string => {
  const m = new Map(vars.map((v) => [str(v.key), str(v.value)]));
  return url.replace(/(\/):([A-Za-z_]\w*)(?=[/?#]|$)/g, (_w, s: string, k: string) => `${s}${m.get(k) || `{{${k}}}`}`);
};

const BOUNDARY = '----httpme';
const CT: Record<string, string> = { json: 'application/json', xml: 'application/xml', html: 'text/html', javascript: 'application/javascript' };

function bodyOf(r: ParsedRequest, body: Obj, warnings: string[]): void {
  const setCt = (v: string) => { if (!r.headers.some((h) => h.name.toLowerCase() === 'content-type')) r.headers.push({ name: 'Content-Type', value: v, enabled: true }); };
  switch (body.mode) {
    case 'raw': {
      r.body = str(body.raw);
      const lang = str(((body.options as Obj | undefined)?.raw as Obj | undefined)?.language);
      if (CT[lang]) setCt(CT[lang]);
      break;
    }
    case 'urlencoded': {
      const rows = arr(body.urlencoded);
      const off = rows.filter((x) => x.disabled === true).length;
      if (off) warnings.push(`${off} disabled form field${off === 1 ? '' : 's'} skipped`);
      r.body = rows.filter((x) => x.disabled !== true).map((x) => `${enc(str(x.key))}=${enc(str(x.value))}`).join('&');
      setCt('application/x-www-form-urlencoded');
      break;
    }
    case 'formdata': {
      const rows = arr(body.formdata).filter((x) => x.disabled !== true);
      const parts = rows.map((x) => {
        if (x.type === 'file') {
          const src = Array.isArray(x.src) ? str(x.src[0]) : str(x.src);
          return `--${BOUNDARY}\nContent-Disposition: form-data; name="${str(x.key)}"; filename="${src.split(/[\\/]/).pop() ?? ''}"\n\n< ${src}`;
        }
        return `--${BOUNDARY}\nContent-Disposition: form-data; name="${str(x.key)}"${x.contentType ? `\nContent-Type: ${str(x.contentType)}` : ''}\n\n${str(x.value)}`;
      });
      r.body = parts.length ? `${parts.join('\n')}\n--${BOUNDARY}--` : '';
      setCt(`multipart/form-data; boundary=${BOUNDARY}`);
      break;
    }
    case 'file': {
      const src = str((body.file as Obj | undefined)?.src);
      if (src) r.bodyFile = src; else warnings.push('Binary body has no file path and was skipped');
      break;
    }
    case 'graphql': {
      const g = isObj(body.graphql) ? body.graphql : {};
      let variables: unknown = {};
      try { variables = g.variables ? JSON.parse(str(g.variables)) : {}; } catch { warnings.push('GraphQL variables are not valid JSON and were dropped'); }
      r.body = JSON.stringify({ query: str(g.query), variables });
      setCt('application/json');
      warnings.push('GraphQL body converted to a JSON POST body');
      break;
    }
    default: break;
  }
}

const descOf = (d: unknown): string => (isObj(d) ? str(d.content) : str(d));
const scriptOf = (events: Obj[], listen: string): string => events.filter((e) => e.listen === listen && isObj(e.script))
  .map((e) => { const x = (e.script as Obj).exec; return Array.isArray(x) ? x.map(str).join('\n') : str(x); }).filter((s) => s.trim() !== '').join('\n');

/** importer satu koleksi; melempar bila bukan Collection v2 */
export function importPostman(json: unknown): ImportPlan {
  if (!isObj(json) || !isObj(json.info) || !Array.isArray(json.item)) {
    if (isObj(json) && Array.isArray(json.order) && Array.isArray(json.requests)) throw new Error('Postman Collection v1 is not supported. Re-export as Collection v2.1 from Postman.');
    throw new Error('The file is not a Postman collection (expected "info" and "item")');
  }
  const root = safeName(str(json.info.name), 'collection');
  const files: ImportFile[] = [];
  const warnings: string[] = [];
  const name = uniqueNamer();
  const dyn = new Set(DYNAMIC_NAMES);

  const scripts = (dir: string, stem: string | undefined, events: Obj[], into: string[]) => {
    for (const [listen, kind] of [['prerequest', 'pre'], ['test', 'post']] as const) {
      const src = scriptOf(events, listen);
      if (!src) continue;
      const t = translateScript(src);
      into.push(...t.warnings);
      files.push({ path: `${dir}/${stem ? `${stem}.` : ''}${kind}-request.js`, content: `${t.code}\n`, warnings: t.warnings });
    }
  };
  const authFile = (dir: string, auth: unknown) => {
    const a = postmanAuth(auth);
    if (a.warning) warnings.push(`${dir}: ${a.warning}`);
    if (a.auth !== undefined) files.push({ path: `${dir}/_auth.http`, content: `# @auth ${a.auth}\n`, warnings: a.warning ? [a.warning] : [] });
  };

  const walk = (items: Obj[], dir: string) => {
    for (const it of items) {
      const title = str(it.name) || 'request';
      if (Array.isArray(it.item)) {
        const sub = name(dir, safeName(title, 'folder'), '');
        authFile(sub, it.auth);
        scripts(sub, undefined, arr(it.event), warnings);
        walk(arr(it.item), sub);
        if (!files.some((f) => f.path.startsWith(`${sub}/`))) files.push({ path: `${sub}/.httpmekeep`, content: '', warnings: [] });
        continue;
      }
      const req = isObj(it.request) ? it.request : typeof it.request === 'string' ? { method: 'GET', url: it.request } : undefined;
      if (!req) continue;
      const method = str(req.method || 'GET').toUpperCase();
      if (!METHODS.includes(method)) { warnings.push(`${title}: method ${method} is not supported, request skipped`); continue; }
      const w: string[] = [];
      const r: ParsedRequest = { ...emptyRequest(), title, method };
      const u = urlOf(req.url);
      r.url = colonVars(u.url, isObj(req.url) ? arr(req.url.variable) : []);
      r.disabledParams = u.disabled;
      r.headers = arr(req.header).map((h): Header => ({ name: str(h.key), value: str(h.value), enabled: h.disabled !== true }));
      const d = descOf(req.description);
      if (d) r.preamble = d.split(/\r?\n/).map((l) => `# ${l}`.trimEnd());
      if (isObj(req.body)) bodyOf(r, req.body, w);
      const a = postmanAuth(req.auth);
      if (a.warning) w.push(a.warning);
      if (a.auth !== undefined) r.auth = a.auth;
      if (isObj(it.protocolProfileBehavior) && it.protocolProfileBehavior.followRedirects === false) r.followRedirects = false;
      for (const m of new Set([...`${r.url}\n${r.body}`.matchAll(/\{\{\s*(\$[^}\s]+)[^}]*\}\}/g)].map((x) => x[1]))) if (!dyn.has(m)) w.push(`Dynamic variable ${m} is not supported by http.me`);
      const path = name(dir, safeName(title), '.http');
      files.push({ path, content: serializeRequest(r), warnings: w });
      scripts(dir, path.slice(dir.length + 1).replace(/\.http$/, ''), arr(it.event), w);
    }
  };

  authFile(root, json.auth);
  scripts(root, undefined, arr(json.event), warnings);
  walk(json.item.filter(isObj), root);
  const vars: EnvVar[] = arr(json.variable).filter((v) => str(v.key) && v.disabled !== true).map((v) => ({ key: str(v.key), value: v.value === undefined || v.value === null ? null : str(v.value) }));
  if (vars.length) files.push({ path: `${root}/_variables.json`, content: serializeEnvironment(vars), warnings: [] });
  for (const f of files) warnings.push(...f.warnings.filter((x) => !warnings.includes(x)).map((x) => `${f.path}: ${x}`));
  return { name: root, format: 'postman', files, warnings };
}
