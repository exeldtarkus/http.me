// export collection http.me -> OpenAPI 3.0.3 / 3.1.0 (Fase 5c), kebalikan openapi.ts; tanpa vscode
import { parseAuth } from './auth';
import type { ExportCollection, ExportFolder, ExportRequest } from './exportModel';
import { multipart } from './exportPostman';
import type { VarValue } from './vars';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dokumen OpenAPI bebas bentuk
type Obj = Record<string, any>;
export type OpenApiVersion = '3.0.3' | '3.1.0';
export type HistoryResponse = { method: string; url: string; status?: number; contentType?: string; body?: string };

const OP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
const normPath = (p: string) => p.replace(/\{[^}]+\}/g, '{}');
/** operationId -> operasi di spec asli */
function indexOriginal(spec: Obj | undefined): Map<string, { m: string; path: string; op: Obj }> {
  const out = new Map<string, { m: string; path: string; op: Obj }>();
  for (const [path, item] of Object.entries(spec?.paths ?? {}) as [string, Obj][]) {
    for (const m of OP_METHODS) if (item?.[m]?.operationId) out.set(item[m].operationId, { m, path: normPath(path), op: item[m] });
  }
  return out;
}
export type ExportOpenApiOptions = {
  version: OpenApiVersion;
  /** Environment: nilai base URL jadi `servers` */ envs: readonly { name: string; values: ReadonlyMap<string, VarValue> }[];
  history: readonly HistoryResponse[];
  /** spec asal import (dari `_source.json`): tag, requestBody, responses, components asli dipertahankan untuk operasi yang method + path-nya sama */
  original?: Obj;
};

const FORMATS: [RegExp, string][] = [
  [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, 'date-time'], [/^\d{4}-\d{2}-\d{2}$/, 'date'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'uuid'], [/^[^@\s{}]+@[^@\s{}]+\.[a-z]{2,}$/i, 'email'],
];
const UUID = FORMATS[2][0];
const SKIP_HEADERS = new Set(['content-type', 'authorization', 'accept', 'user-agent', 'host', 'content-length', 'accept-encoding', 'accept-language', 'connection', 'origin', 'referer', 'cookie', 'cache-control', 'pragma']);
const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 500: 'Internal Server Error' };

/** schema diturunkan dari contoh nilai JSON */
export function schemaOf(v: unknown, version: OpenApiVersion): Obj {
  if (v === null) return version === '3.1.0' ? { type: 'null' } : { nullable: true };
  if (Array.isArray(v)) return { type: 'array', items: v.length ? schemaOf(v[0], version) : {} };
  switch (typeof v) {
    case 'boolean': return { type: 'boolean' };
    case 'number': return { type: Number.isInteger(v) ? 'integer' : 'number' };
    case 'string': { const f = FORMATS.find(([re]) => re.test(v))?.[1]; return { type: 'string', ...(f ? { format: f } : {}) }; }
    case 'object': return { type: 'object', properties: Object.fromEntries(Object.entries(v as Obj).map(([k, x]) => [k, schemaOf(x, version)])) };
    default: return {};
  }
}

/** teks -> nilai JSON; token {{var}} tanpa tanda kutip dianggap null supaya body ber-template tetap terbaca */
function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  for (const t of [text, text.replace(/\{\{[^}]*\}\}/g, 'null')]) {
    try { return { ok: true, value: JSON.parse(t) }; } catch { /* coba bentuk berikutnya */ }
  }
  return { ok: false };
}

const scalar = (s: string): { schema: Obj; example?: unknown } => {
  if (/\{\{/.test(s)) return { schema: { type: 'string' } };
  if (/^-?\d+$/.test(s)) return { schema: { type: 'integer' }, example: Number(s) };
  if (/^-?\d+\.\d+$/.test(s)) return { schema: { type: 'number' }, example: Number(s) };
  if (s === 'true' || s === 'false') return { schema: { type: 'boolean' }, example: s === 'true' };
  const f = FORMATS.find(([re]) => re.test(s))?.[1];
  return { schema: { type: 'string', ...(f ? { format: f } : {}) }, example: s };
};

const camel = (s: string) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toLowerCase());
const singular = (s: string) => (/ies$/.test(s) ? `${s.slice(0, -3)}y` : /[^s]s$/.test(s) && s.length > 3 ? s.slice(0, -1) : s);

type Parsed = { path: string; params: Obj[]; base?: { kind: 'var'; name: string } | { kind: 'origin'; origin: string } };

/** URL http.me -> path template + path param; base ({{baseUrl}} atau origin literal) dilepas */
function parseUrl(url: string): Parsed {
  let rest = url.replace(/[?#].*$/s, '');
  let base: Parsed['base'];
  const v = /^\{\{\s*([\w.-]+)\s*\}\}/.exec(rest);
  const o = /^[a-z][\w+.-]*:\/\/[^/]+/i.exec(rest);
  if (v) { base = { kind: 'var', name: v[1] }; rest = rest.slice(v[0].length); } else if (o) { base = { kind: 'origin', origin: o[0] }; rest = rest.slice(o[0].length); }
  const used = new Set<string>();
  const params: Obj[] = [];
  let prev = '';
  const segs = rest.split('/').filter((s) => s !== '').map((seg) => {
    const name = (n: string) => { let u = n; for (let i = 2; used.has(u); i++) u = `${n}${i}`; used.add(u); return u; };
    const m = /^\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}$/.exec(seg);
    let out = seg;
    if (m) { const n = name(camel(m[1])); params.push({ name: n, in: 'path', required: true, schema: { type: 'string' } }); out = `{${n}}`; } else if (/^\d+$/.test(seg) || UUID.test(seg)) {
      const n = name(prev ? `${singular(prev)}Id` : 'id');
      const s = scalar(seg);
      params.push({ name: n, in: 'path', required: true, schema: s.schema, example: s.example });
      out = `{${n}}`;
    } else prev = camel(seg) || prev;
    return out;
  });
  return { path: `/${segs.join('/')}`, params, base };
}

type Scheme = { name: string; scheme: Obj };
function schemeOf(text: string, warn: (w: string) => void): Scheme | 'none' | undefined {
  try {
    const a = parseAuth(text, []);
    const f = a.fields;
    switch (a.type) {
      case 'none': return 'none';
      case 'basic': return { name: 'basicAuth', scheme: { type: 'http', scheme: 'basic' } };
      case 'bearer': return { name: 'bearerAuth', scheme: { type: 'http', scheme: 'bearer' } };
      case 'digest': return { name: 'digestAuth', scheme: { type: 'http', scheme: 'digest' } };
      case 'apiKey': return { name: 'apiKeyAuth', scheme: { type: 'apiKey', name: f.key || 'X-API-Key', in: ['query', 'cookie'].includes(f.in) ? f.in : 'header' } };
      case 'oauth2': {
        const scopes = Object.fromEntries((f.scope ?? '').split(/\s+/).filter(Boolean).map((s) => [s, '']));
        const flow = { client_credentials: 'clientCredentials', authorization_code: 'authorizationCode', password: 'password', implicit: 'implicit' }[f.grant] ?? 'authorizationCode';
        const body = { ...(flow === 'authorizationCode' || flow === 'implicit' ? { authorizationUrl: f.authorization_url ?? '' } : {}), ...(flow !== 'implicit' ? { tokenUrl: f.token_url ?? '' } : {}), scopes };
        return { name: 'oauth2', scheme: { type: 'oauth2', flows: { [flow]: body } } };
      }
      default: warn(`Authorization "${a.type}" has no OpenAPI equivalent and was skipped`); return undefined;
    }
  } catch (e) {
    warn(`Authorization skipped (${(e as Error).message})`); // peringatan masuk laporan export, bukan error yang ditelan
    return undefined;
  }
}

type Flat = { x: ExportRequest; tag?: string; auth?: string; where: string };
function flatten(f: ExportFolder, trail: string[], auth: string | undefined, out: Flat[]): void {
  const a = f.auth?.trim() ? f.auth : auth;
  for (const i of f.items) {
    if (i.kind === 'folder') flatten(i, [...trail, i.name], a, out);
    else out.push({ x: i, ...(trail.length ? { tag: trail.join(' / ') } : {}), ...(a !== undefined ? { auth: a } : {}), where: [...trail, i.name].join('/') });
  }
}

const FORM_CT = 'application/x-www-form-urlencoded';

function requestBody(r: ExportRequest['req'], version: OpenApiVersion): Obj | undefined {
  if (r.bodyFile) return { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
  if (r.body === '') return undefined;
  const ctHeader = r.headers.find((h) => h.enabled && h.name.toLowerCase() === 'content-type')?.value ?? '';
  const ct = ctHeader.split(';')[0].trim().toLowerCase() || ({ json: 'application/json', xml: 'application/xml', form: FORM_CT, text: 'text/plain', none: 'text/plain' }[r.bodyType]);
  const b = /boundary=("?)([^";\s]+)\1/i.exec(ctHeader);
  let content: Obj;
  if (ct === 'multipart/form-data' && b) {
    const rows = multipart(r.body, b[2]) ?? [];
    content = { schema: { type: 'object', properties: Object.fromEntries(rows.map((x) => [x.key, x.type === 'file' ? { type: 'string', format: 'binary' } : { type: 'string' }])) } };
  } else if (ct === FORM_CT) {
    const rows = r.body.split('&').filter(Boolean).map((p) => p.split('=')[0]);
    content = { schema: { type: 'object', properties: Object.fromEntries(rows.map((k) => [k, { type: 'string' }])) } };
  } else if (/[/+]json$/.test(ct)) {
    const j = tryJson(r.body);
    content = j.ok ? { schema: schemaOf(j.value, version), example: j.value } : { schema: {} };
  } else content = { schema: { type: 'string' }, example: r.body };
  return { required: true, content: { [ct]: content } };
}

function responsesOf(list: readonly HistoryResponse[], version: OpenApiVersion): Obj {
  const out: Obj = {};
  for (const h of [...list].sort((a, b) => (a.status ?? 0) - (b.status ?? 0))) {
    if (!h.status || out[h.status]?.content) continue;
    const res: Obj = { description: STATUS_TEXT[h.status] ?? `HTTP ${h.status}` };
    if (h.body) {
      const j = tryJson(h.body);
      const ct = (h.contentType ?? (j.ok ? 'application/json' : 'text/plain')).split(';')[0].trim();
      res.content = { [ct]: j.ok && /json/.test(ct) ? { schema: schemaOf(j.value, version), example: j.value } : { schema: { type: 'string' }, example: h.body } };
    }
    out[h.status] = res;
  }
  return Object.keys(out).length ? out : { 200: { description: 'OK' } };
}

export function toOpenApi(c: ExportCollection, o: ExportOpenApiOptions): { doc: Obj; warnings: string[]; requests: number; skipped: string[] } {
  const warnings = [...c.warnings];
  const skipped: string[] = [];
  const flat: Flat[] = [];
  flatten(c, [], undefined, flat);
  const rootAuth = c.auth?.trim() ? c.auth : undefined;
  const schemes = new Map<string, Obj>(); // nama -> scheme
  const schemeName = (s: Scheme): string => {
    for (const [n, v] of schemes) if (JSON.stringify(v) === JSON.stringify(s.scheme)) return n;
    let n = s.name;
    for (let i = 2; schemes.has(n); i++) n = `${s.name}${i}`;
    schemes.set(n, s.scheme);
    return n;
  };
  const security = (text: string, where: string): Obj[] | undefined => {
    const s = schemeOf(text, (w) => warnings.push(`${where}: ${w}`));
    return s === 'none' ? [] : s ? [{ [schemeName(s)]: [] }] : undefined;
  };

  const doc: Obj = { openapi: o.version, info: { title: c.name, version: '1.0.0' }, paths: {} };
  const baseVars = new Map<string, number>();
  const origins = new Set<string>();
  const ids = new Set<string>();
  let scripts = 0;
  let count = 0;
  const origIndex = indexOriginal(o.original);
  const v3 = typeof o.original?.openapi === 'string';
  let usedOriginal = false;
  const globalSec = rootAuth ? security(rootAuth, c.name) : undefined;
  if (globalSec?.length) doc.security = globalSec;

  for (const f of flat) {
    const { x } = f;
    const r = x.req;
    const m = r.method.toLowerCase();
    if (!['get', 'put', 'post', 'delete', 'options', 'head', 'patch'].includes(m)) { skipped.push(f.where); warnings.push(`${f.where}: method ${r.method} has no OpenAPI equivalent, skipped`); continue; }
    const u = parseUrl(r.url);
    const item: Obj = (doc.paths[u.path] ??= {});
    if (item[m]) { skipped.push(f.where); warnings.push(`${f.where}: duplicate operation ${r.method} ${u.path}, skipped`); continue; }
    if (u.base?.kind === 'var') baseVars.set(u.base.name, (baseVars.get(u.base.name) ?? 0) + 1); else if (u.base) origins.add(u.base.origin);
    if (x.pre || x.post) scripts++;

    const query = r.url.includes('?') ? r.url.replace(/#.*$/s, '').slice(r.url.indexOf('?') + 1).split('&').filter(Boolean) : [];
    const mkQuery = (k: string, v: string, required: boolean): Obj => { const s = scalar(v); return { name: k, in: 'query', required, schema: s.schema, ...(s.example !== undefined ? { example: s.example } : {}) }; };
    const params: Obj[] = [
      ...u.params,
      ...query.map((p) => { const eq = p.indexOf('='); return mkQuery(eq < 0 ? p : p.slice(0, eq), eq < 0 ? '' : p.slice(eq + 1), true); }),
      ...r.disabledParams.map((p) => mkQuery(p.key, p.value, false)),
      ...r.headers.filter((h) => h.name !== '' && !SKIP_HEADERS.has(h.name.toLowerCase())).map((h): Obj => { const s = scalar(h.value); return { name: h.name, in: 'header', required: h.enabled, schema: s.schema, ...(s.example !== undefined ? { example: s.example } : {}) }; }),
    ];

    let id = r.operation || r.name || camel(r.title || x.name) || `${m}${camel(u.path)}`;
    for (let i = 2; ids.has(id); i++) id = `${r.operation || r.name || camel(r.title || x.name)}_${i}`;
    ids.add(id);
    const desc = r.preamble.map((l) => l.replace(/^(#|\/\/)\s?/, '')).join('\n');
    const body = requestBody(r, o.version);
    const effective = r.auth !== undefined && r.auth.trim() !== '' ? r.auth : f.auth;
    const sec = effective !== undefined && effective !== rootAuth ? security(effective, f.where) : undefined;
    const o1 = origIndex.get(id);
    const orig = o1 && o1.m === m && o1.path === normPath(u.path) ? o1.op : undefined;
    if (orig && v3) usedOriginal = true;
    const hist = o.history.filter((h) => h.method.toUpperCase() === r.method.toUpperCase() && h.url === r.url);
    const origResponses = orig?.responses && !hist.length ? (v3 ? orig.responses : Object.fromEntries(Object.entries(orig.responses as Obj).map(([k, v]) => [k, { description: String((v as Obj)?.description ?? 'Response') }]))) : undefined;
    const tag = orig?.tags?.[0] ?? f.tag;
    item[m] = {
      ...(tag ? { tags: [tag] } : {}), ...(r.title ? { summary: r.title } : {}), ...(desc ? { description: desc } : {}), operationId: id,
      ...(params.length ? { parameters: params } : {}), ...(orig && v3 && orig.requestBody ? { requestBody: orig.requestBody } : body ? { requestBody: body } : {}), ...(sec ? { security: sec } : {}),
      responses: origResponses ?? responsesOf(hist, o.version),
    };
    count++;
  }
  if (scripts) warnings.push(`Scripts are not part of OpenAPI: ${scripts} request${scripts === 1 ? '' : 's'} had scripts that were left out`);

  // servers: nilai variable base URL tiap Environment; tanpa Environment pakai origin literal
  const names = [...baseVars].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const servers: Obj[] = [];
  for (const e of o.envs) {
    const v = names.map((n) => e.values.get(n)).find((x): x is string => typeof x === 'string' && x !== '');
    if (v) servers.push({ url: v.replace(/\/+$/, ''), description: e.name });
  }
  if (!servers.length) for (const origin of origins) servers.push({ url: origin });
  if (servers.length) doc.servers = servers;
  const { securitySchemes: _drop, ...keptComponents } = usedOriginal ? (o.original?.components ?? {}) as Obj : {};
  if (schemes.size || Object.keys(keptComponents).length) doc.components = { ...keptComponents, ...(schemes.size ? { securitySchemes: Object.fromEntries(schemes) } : {}) };
  return { doc, warnings, requests: count, skipped };
}

export function validateOpenApi(doc: Obj): string[] {
  const errors: string[] = [];
  if (typeof doc.openapi !== 'string') errors.push('"openapi" is required');
  if (!doc.info?.title || !doc.info.version) errors.push('info.title and info.version are required');
  if (!doc.paths || typeof doc.paths !== 'object') errors.push('"paths" is required');
  const ids = new Set<string>();
  for (const [p, item] of Object.entries(doc.paths ?? {}) as [string, Obj][]) {
    if (!p.startsWith('/')) errors.push(`path "${p}" must start with "/"`);
    for (const [m, op] of Object.entries(item) as [string, Obj][]) {
      if (!op.responses) errors.push(`${m} ${p}: responses are required`);
      if (op.operationId) { if (ids.has(op.operationId)) errors.push(`duplicate operationId ${op.operationId}`); ids.add(op.operationId); }
    }
  }
  return errors;
}
