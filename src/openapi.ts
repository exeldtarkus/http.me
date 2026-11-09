// Swagger 2.0 / OpenAPI 3.0 / 3.1 -> folder per tag + file .http per operasi (tanpa vscode); input sudah di-parse (JSON / YAML)
import { posix } from 'node:path';
import { emptyRequest, serializeRequest, type Header, type ParsedRequest } from './httpFile';
import { authText, safeName, uniqueNamer, type ImportFile, type ImportPlan } from './importCommon';
import type { VarValue } from './vars';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- spec bebas bentuk; dibaca defensif
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);

export type OpenApiOptions = {
  /** Environment yang ada: nilai base URL / nama path param dicocokkan dengannya */
  envs?: readonly { name: string; values: ReadonlyMap<string, VarValue> }[];
  /** isi file `$ref` relatif (path posix relatif ke root spec); melempar bila tidak ada */
  loadFile?: (rel: string) => unknown;
};

const MAX_DEPTH = 5;
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
const BOUNDARY = '----httpme';

// ---------- $ref ----------
class Refs {
  private docs = new Map<string, unknown>();
  constructor(root: unknown, private load: (rel: string) => unknown, readonly warnings: string[]) { this.docs.set('', root); }
  private doc(file: string): unknown {
    if (!this.docs.has(file)) this.docs.set(file, this.load(file));
    return this.docs.get(file);
  }
  /** ikuti rantai $ref sampai node bukan referensi; key = identitas ref (deteksi melingkar), file = tempat node berada */
  deref(node: unknown, file: string, seen = new Set<string>()): { node: any; file: string; key?: string } { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!isObj(node) || typeof node.$ref !== 'string') return { node, file };
    const [path, frag = ''] = (node.$ref as string).split('#');
    const target = path ? posix.normalize(posix.join(posix.dirname(file) === '.' ? '' : posix.dirname(file), path)) : file;
    const key = `${target}#${frag}`;
    if (seen.has(key)) return { node: {}, file: target, key };
    seen.add(key);
    try {
      let cur: any = this.doc(target); // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const part of frag.split('/').filter(Boolean)) {
        cur = cur?.[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')];
        if (cur === undefined) throw new Error('not found');
      }
      const next = this.deref(cur, target, seen);
      return { ...next, key: next.key ?? key };
    } catch (e) {
      // sengaja tidak dilempar: $ref rusak jadi peringatan di laporan import (dicatat pemanggil), import lain tetap jalan
      const w = `Unresolved $ref ${node.$ref as string}${e instanceof Error && e.message !== 'not found' ? ` (${e.message})` : ''}`;
      if (!this.warnings.includes(w)) this.warnings.push(w);
      return { node: {}, file, key };
    }
  }
}

// ---------- contoh dari schema ----------
type SampleCtx = { refs?: Refs; file?: string; stack?: Set<string>; forRequest?: boolean };

const STRING_FORMAT: Record<string, string> = {
  'date-time': '2024-01-01T00:00:00Z', date: '2024-01-01', time: '00:00:00', uuid: '00000000-0000-0000-0000-000000000000', email: 'user@example.com',
  uri: 'https://example.com', url: 'https://example.com', hostname: 'example.com', ipv4: '127.0.0.1', ipv6: '::1', byte: 'c3RyaW5n', binary: '',
};
const typeOf = (s: Obj): string | undefined => (Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type);

/** contoh nilai dari schema: example → default → enum → tipe; $ref, allOf (digabung), oneOf / anyOf (pertama), kedalaman dibatasi */
export function sampleFor(schema: unknown, ctx: SampleCtx, depth = 0): unknown {
  let file = ctx.file ?? '';
  let node: any = schema; // eslint-disable-line @typescript-eslint/no-explicit-any
  const stack = ctx.stack ?? new Set<string>();
  let added: string | undefined;
  if (ctx.refs && isObj(node) && node.$ref) {
    const r = ctx.refs.deref(node, file);
    if (r.key && stack.has(r.key)) return null;
    node = r.node; file = r.file;
    if (r.key) { stack.add(r.key); added = r.key; }
  }
  try {
    if (!isObj(node) || depth > MAX_DEPTH) return depth > MAX_DEPTH ? null : {};
    const sub = { ...ctx, file, stack };
    if (node.example !== undefined) return node.example;
    if (node['x-example'] !== undefined) return node['x-example'];
    if (node.default !== undefined) return node.default;
    if (node.const !== undefined) return node.const;
    if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];
    if (Array.isArray(node.allOf)) {
      const parts = node.allOf.map((s: unknown) => sampleFor(s, sub, depth + 1));
      return parts.every(isObj) ? Object.assign({}, ...parts) : parts[0];
    }
    for (const k of ['oneOf', 'anyOf'] as const) if (Array.isArray(node[k]) && node[k].length) return sampleFor(node[k][0], sub, depth + 1);
    const t = typeOf(node) ?? (node.properties ? 'object' : node.items ? 'array' : undefined);
    switch (t) {
      case 'object': {
        const out: Obj = {};
        for (const [k, v] of Object.entries<any>(node.properties ?? {})) { // eslint-disable-line @typescript-eslint/no-explicit-any
          const resolved = ctx.refs ? ctx.refs.deref(v, file).node : v;
          if (ctx.forRequest !== false && isObj(resolved) && resolved.readOnly === true) continue;
          out[k] = sampleFor(v, sub, depth + 1);
        }
        return out;
      }
      case 'array': return [sampleFor(node.items ?? {}, sub, depth + 1)];
      case 'integer': case 'number': return typeof node.minimum === 'number' ? node.minimum : 0;
      case 'boolean': return true;
      case 'null': return null;
      case 'string': return STRING_FORMAT[node.format] ?? 'string';
      default: return 'string';
    }
  } finally {
    if (added) stack.delete(added);
  }
}

const xmlEscape = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
function toXml(name: string, v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => toXml(name, x)).join('');
  if (isObj(v)) return `<${name}>${Object.entries(v).map(([k, x]) => toXml(k, x)).join('')}</${name}>`;
  return `<${name}>${xmlEscape(String(v ?? ''))}</${name}>`;
}
const text = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(text).join(',') : isObj(v) ? JSON.stringify(v) : String(v));
const enc = (s: string) => encodeURIComponent(s);

// ---------- security ----------
type Sec = { auth?: string; header?: Header; warning?: string };
function securityOf(schemes: Obj, requirement: unknown, refs: Refs): Sec {
  if (!isObj(requirement)) return {};
  const name = Object.keys(requirement)[0];
  if (!name) return {};
  const s = refs.deref(schemes[name], '').node;
  if (!isObj(s)) return { warning: `Security scheme "${name}" is not defined` };
  const wanted: string[] = Array.isArray(requirement[name]) ? requirement[name] : [];
  const scope = (all: Obj | undefined) => (wanted.length ? wanted : Object.keys(all ?? {})).join(' ');
  const t = s.type === 'basic' ? 'http' : s.type;
  if (t === 'http') {
    const scheme = s.type === 'basic' ? 'basic' : String(s.scheme ?? '').toLowerCase();
    if (scheme === 'basic') return { auth: authText('basic', { username: '{{username}}', password: '{{password}}' }) };
    if (scheme === 'bearer') return { auth: authText('bearer', { token: '{{token}}' }) };
    if (scheme === 'digest') return { auth: authText('digest', { username: '{{username}}', password: '{{password}}' }) };
    return { warning: `HTTP auth scheme "${scheme}" is not supported` };
  }
  if (t === 'apiKey') {
    if (s.in === 'cookie') return { header: { name: 'Cookie', value: `${s.name}={{apiKey}}`, enabled: true } };
    return { auth: authText('apiKey', { key: String(s.name), value: '{{apiKey}}', in: s.in === 'query' ? 'query' : 'header' }) };
  }
  if (t === 'oauth2') {
    // v3: flows.{implicit,password,clientCredentials,authorizationCode}; v2: flow + url di scheme
    const flows: Obj = s.flows ?? { [{ implicit: 'implicit', password: 'password', application: 'clientCredentials', accessCode: 'authorizationCode' }[String(s.flow)] ?? 'implicit']: s };
    const [kind, f] = (['clientCredentials', 'authorizationCode', 'password', 'implicit'] as const).map((k) => [k, flows[k]] as const).find((x) => isObj(x[1])) ?? ['implicit', {}];
    const grant = { clientCredentials: 'client_credentials', authorizationCode: 'authorization_code', password: 'password', implicit: 'implicit' }[kind];
    const useAuthUrl = kind === 'authorizationCode' || kind === 'implicit';
    const useTokenUrl = kind !== 'implicit';
    return { auth: authText('oauth2', {
      grant, ...(useAuthUrl ? { authorization_url: String(f.authorizationUrl ?? '') } : {}), ...(useTokenUrl ? { token_url: String(f.tokenUrl ?? '') } : {}),
      scope: scope(f.scopes ?? s.scopes),
      ...(kind === 'implicit' ? {} : { client_id: '{{clientId}}', client_secret: '{{clientSecret}}' }),
      ...(kind === 'password' ? { username: '{{username}}', password: '{{password}}' } : {}),
    }) };
  }
  if (t === 'openIdConnect') {
    return { auth: authText('oauth2', { grant: 'authorization_code', authorization_url: '{{authorizationUrl}}', token_url: '{{tokenUrl}}', client_id: '{{clientId}}', client_secret: '{{clientSecret}}' }),
      warning: `OpenID Connect: set authorizationUrl / tokenUrl from ${String(s.openIdConnectUrl ?? 'the discovery document')}` };
  }
  return { warning: `Security scheme type "${String(s.type)}" is not supported` };
}

// ---------- base URL ----------
function baseUrlOf(doc: Obj): string {
  if (doc.swagger) {
    if (!doc.host) return String(doc.basePath ?? '').replace(/\/$/, '');
    const scheme = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes[0] : 'https';
    return `${scheme}://${doc.host}${String(doc.basePath ?? '')}`.replace(/\/$/, '');
  }
  const server = Array.isArray(doc.servers) ? doc.servers[0] : undefined;
  if (!isObj(server) || typeof server.url !== 'string') return '';
  return server.url.replace(/\{([^}]+)\}/g, (w: string, n: string) => String(server.variables?.[n]?.default ?? w)).replace(/\/$/, '');
}
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

type Param = { name: string; in: string; required: boolean; value: string };

export function importOpenApi(spec: unknown, opts: OpenApiOptions = {}): ImportPlan {
  if (!isObj(spec) || (!spec.openapi && !spec.swagger)) throw new Error('The file is not an OpenAPI / Swagger spec (expected "openapi" or "swagger")');
  if (!isObj(spec.paths) || !Object.keys(spec.paths).length) throw new Error('The spec has no paths to import');
  const doc = spec;
  const warnings: string[] = [];
  const refs = new Refs(doc, opts.loadFile ?? ((rel) => { throw new Error(`external files are not available (${rel})`); }), warnings);
  const root = safeName(String(doc.info?.title ?? 'api'), 'api');
  const files: ImportFile[] = [];
  const name = uniqueNamer();
  const envs = opts.envs ?? [];

  // base URL: cocok dengan nilai Environment, selain itu variable baru <NAMA>_BASE_URL
  const base = baseUrlOf(doc);
  let baseVar = '';
  let environmentVars: ImportPlan['environmentVars'];
  if (base) {
    const hit = envs.flatMap((e) => [...e.values]).find(([, v]) => typeof v === 'string' && sameUrl(v, base));
    if (hit) baseVar = hit[0];
    else {
      baseVar = `${root.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'API'}_BASE_URL`;
      environmentVars = [{ key: baseVar, value: base }];
    }
  }
  const envKeys = new Set(envs.flatMap((e) => [...e.values.keys()]));

  const schemes: Obj = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
  const globalSec = Array.isArray(doc.security) ? doc.security : undefined;
  const globalAuth = globalSec?.length ? securityOf(schemes, globalSec[0], refs) : {};
  if (globalAuth.warning) warnings.push(globalAuth.warning);
  if (globalAuth.auth) files.push({ path: `${root}/_auth.http`, content: `# @auth ${globalAuth.auth}\n`, warnings: globalAuth.warning ? [globalAuth.warning] : [] });

  for (const [path, rawItem] of Object.entries<any>(doc.paths)) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const itemR = refs.deref(rawItem, '');
    const item: Obj = isObj(itemR.node) ? itemR.node : {};
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const w: string[] = [];
      const r: ParsedRequest = { ...emptyRequest(), method: method.toUpperCase() };
      const operationId = typeof op.operationId === 'string' && op.operationId ? op.operationId : undefined;
      r.title = String(op.summary ?? operationId ?? `${r.method} ${path}`).replace(/\s*\n\s*/g, ' ');
      if (operationId) r.name = operationId;
      r.operation = operationId ?? `${method} ${path}`;
      if (typeof op.description === 'string' && op.description.trim()) r.preamble = op.description.trim().split(/\r?\n/).map((l: string) => `# ${l}`.trimEnd());

      // parameter: path-level + operasi (operasi menimpa), $ref di-resolve
      const merged = new Map<string, Obj & { file: string }>();
      for (const list of [item.parameters, op.parameters]) {
        for (const raw of Array.isArray(list) ? list : []) {
          const d = refs.deref(raw, itemR.file);
          if (isObj(d.node) && d.node.name) merged.set(`${d.node.in}:${d.node.name}`, { ...d.node, file: d.file });
        }
      }
      const params: Param[] = [...merged.values()].map((p) => {
        const sch = p.schema ?? p;
        const ex = p.example ?? (isObj(p.examples) ? (Object.values(p.examples)[0] as Obj | undefined)?.value : undefined);
        return { name: p.name, in: p.in, required: p.required === true || p.in === 'path', value: text(ex ?? sampleFor(sch, { refs, file: p.file })) };
      });
      let pathStr = path.replace(/\{([^}]+)\}/g, (_w, n: string) => {
        const p = params.find((x) => x.in === 'path' && x.name === n);
        return envKeys.has(n) ? `{{${n}}}` : p ? p.value : `{{${n}}}`;
      });
      const q = params.filter((p) => p.in === 'query');
      pathStr += q.some((p) => p.required) ? `?${q.filter((p) => p.required).map((p) => `${p.name}=${p.value}`).join('&')}` : '';
      r.disabledParams = q.filter((p) => !p.required).map((p) => ({ key: p.name, value: p.value }));
      r.headers = params.filter((p) => p.in === 'header' && !/^(accept|content-type|authorization)$/i.test(p.name)).map((p) => ({ name: p.name, value: p.value, enabled: p.required }));
      r.url = `${baseVar ? `{{${baseVar}}}` : ''}${pathStr}`;

      body(op, doc, refs, itemR.file, r, w, Array.isArray(item.parameters) ? item.parameters : []);

      const sec = op.security === undefined ? undefined : Array.isArray(op.security) ? op.security : undefined;
      if (sec && sec.length === 0) r.auth = 'none';
      else {
        const inherits = !sec || JSON.stringify(sec) === JSON.stringify(globalSec);
        const s = inherits ? globalAuth : securityOf(schemes, sec![0], refs);
        if (s.header) r.headers.push(s.header);
        if (!inherits) {
          if (s.auth) r.auth = s.auth;
          if (s.warning) { w.push(s.warning); warnings.push(s.warning); }
        }
      }

      const tag = Array.isArray(op.tags) && op.tags.length ? String(op.tags[0]) : 'default';
      const dir = `${root}/${safeName(tag, 'default')}`;
      const stem = operationId ? safeName(operationId) : `${r.method}-${path.replace(/[{}]/g, '').split('/').filter(Boolean).join('-') || 'root'}`;
      files.push({ path: name(dir, stem, '.http'), content: serializeRequest(r), warnings: w, operation: r.operation });
    }
  }
  for (const f of files) warnings.push(...f.warnings.filter((x) => !warnings.includes(x)).map((x) => `${f.path}: ${x}`));
  return { name: root, format: 'openapi', files, warnings, ...(environmentVars ? { environmentVars } : {}) };
}

/** body request: v3 requestBody.content / v2 parameters in body|formData */
function body(op: Obj, doc: Obj, refs: Refs, file: string, r: ParsedRequest, w: string[], itemParams: readonly unknown[]): void {
  const setCt = (v: string) => { if (!r.headers.some((h) => h.name.toLowerCase() === 'content-type')) r.headers.push({ name: 'Content-Type', value: v, enabled: true }); };
  const ctx = { refs, file, forRequest: true };
  let ct: string | undefined;
  let media: Obj | undefined;
  if (doc.swagger) {
    const raw: Obj[] = [...(op.parameters ?? []), ...itemParams].map((p) => refs.deref(p, file).node).filter(isObj);
    const bodyP = raw.find((p) => p.in === 'body');
    const form = raw.filter((p) => p.in === 'formData');
    const consumes: string[] = op.consumes ?? doc.consumes ?? ['application/json'];
    if (bodyP) { ct = consumes.find((c) => /json/.test(c)) ?? consumes[0]; media = { schema: bodyP.schema }; }
    else if (form.length) {
      ct = form.some((p) => p.type === 'file') ? 'multipart/form-data' : consumes.find((c) => /x-www-form-urlencoded|multipart/.test(c)) ?? 'application/x-www-form-urlencoded';
      media = { schema: { type: 'object', properties: Object.fromEntries(form.map((p) => [p.name, p.type === 'file' ? { type: 'string', format: 'binary' } : p])) } };
    }
  } else if (isObj(op.requestBody)) {
    const rb = refs.deref(op.requestBody, file).node;
    const content: Obj = isObj(rb) && isObj(rb.content) ? rb.content : {};
    const types = Object.keys(content);
    ct = types.find((c) => /json/.test(c)) ?? types.find((c) => /x-www-form-urlencoded/.test(c)) ?? types.find((c) => /multipart/.test(c)) ?? types.find((c) => /^text\/plain/.test(c)) ?? types.find((c) => /xml/.test(c)) ?? types[0];
    media = ct ? refs.deref(content[ct], file).node : undefined;
  }
  if (!ct || !isObj(media)) return;
  const ex = media.example !== undefined ? media.example : isObj(media.examples) && Object.keys(media.examples).length ? refs.deref(Object.values(media.examples)[0], file).node?.value : undefined;
  const value = ex !== undefined ? ex : media.schema !== undefined ? sampleFor(media.schema, ctx) : undefined;
  if (value === undefined) return;
  if (/json/.test(ct)) { r.body = JSON.stringify(value, null, 2); setCt(ct); }
  else if (/x-www-form-urlencoded/.test(ct)) { r.body = isObj(value) ? Object.entries(value).map(([k, v]) => `${enc(k)}=${enc(text(v))}`).join('&') : text(value); setCt(ct); }
  else if (/multipart/.test(ct)) {
    const props: Obj = media.schema ? (refs.deref(media.schema, file).node?.properties ?? {}) : {};
    const parts = Object.entries(isObj(value) ? value : {}).map(([k, v]) => {
      const p = refs.deref(props[k], file).node;
      if (isObj(p) && (p.format === 'binary' || p.type === 'file')) return `--${BOUNDARY}\nContent-Disposition: form-data; name="${k}"; filename="${k}"\n\n< ./${k}`;
      return `--${BOUNDARY}\nContent-Disposition: form-data; name="${k}"\n\n${text(v)}`;
    });
    r.body = parts.length ? `${parts.join('\n')}\n--${BOUNDARY}--` : '';
    setCt(`multipart/form-data; boundary=${BOUNDARY}`);
  } else if (/xml/.test(ct)) {
    const sch = media.schema ? refs.deref(media.schema, file).node : undefined;
    r.body = typeof value === 'string' ? value : toXml(String(sch?.xml?.name ?? 'root'), value);
    setCt(ct);
  } else if (/^text\//.test(ct)) { r.body = text(value); setCt(ct); }
  else w.push(`Request body type ${ct} is not supported and was skipped`);
}
