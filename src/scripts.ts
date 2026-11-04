// script pre-request / post-request (tanpa vscode): cari rantai script untuk satu request .http
import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { parseRequest, splitBlocks, type ParsedRequest } from './httpFile';

export type ScriptKind = 'pre' | 'post';
/** file .js (path absolut) atau script inline `{% … %}` (isi tanpa pembatas) */
export type ScriptRef = { file: string } | { inline: string };

const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** folder dari root ke folder .http (teratas → terdekat); .http di luar root = hanya foldernya sendiri */
function folders(root: string, httpFile: string): string[] {
  const dir = dirname(httpFile);
  const rel = relative(root, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) return [dir];
  const out = [root];
  for (const part of rel ? rel.split(/[\\/]/) : []) out.push(join(out[out.length - 1], part));
  return out;
}

/**
 * urutan jalan: `pre-request.js` / `post-request.js` folder teratas → terdekat, lalu baris `<` / `>` atas → bawah,
 * terakhir script milik request (`<nama>.pre-request.js`).
 * Script yang sama hanya sekali; path tidak ada / berkoma = error (request tidak dikirim).
 */
export async function scriptChain(root: string, httpFile: string, r: ParsedRequest, kind: ScriptKind): Promise<ScriptRef[]> {
  if (r.noScripts || (kind === 'pre' ? r.noPre : r.noPost)) return [];
  const out: ScriptRef[] = [];
  const seen = new Set<string>();
  const add = (file: string) => { if (!seen.has(file)) { seen.add(file); out.push({ file }); } };
  for (const dir of folders(root, httpFile)) {
    const f = join(dir, `${kind}-request.js`);
    if (await exists(f)) add(f);
  }
  for (const sc of kind === 'pre' ? r.preScripts : r.postScripts) {
    const inline = /^\{%([\s\S]*)%\}$/.exec(sc);
    if (inline) { out.push({ inline: inline[1] }); continue; }
    if (sc.includes(',')) throw new Error(`Use one script path per line: ${sc}`);
    const f = resolve(dirname(httpFile), sc);
    if (!(await exists(f))) throw new Error(`Script file not found: ${sc} (${relative(root, f)})`);
    add(f);
  }
  const own = ownScript(httpFile, kind);
  if (await exists(own)) add(own);
  return out;
}

/** script milik request: `page.http` → `page.pre-request.js` / `page.post-request.js` di sampingnya */
export const ownScript = (httpFile: string, kind: ScriptKind): string =>
  join(dirname(httpFile), `${basename(httpFile).replace(/\.http$/i, '')}.${kind}-request.js`);

/** .http di-rename / dipindah: pasangan [lama, baru] script miliknya (pemanggil memindahkan yang ada) */
export const sidecarMoves = (from: string, to: string): [string, string][] =>
  /\.http$/i.test(from) && /\.http$/i.test(to) ? (['pre', 'post'] as const).map((k) => [ownScript(from, k), ownScript(to, k)]) : [];

/** path di baris `< x` / `> x` sebuah .http (posisi karakter di baris): pre = sebelum baris request, body = `< file` setelah header, post = `>` */
export type PathRef = { path: string; line: number; start: number; end: number; kind: ScriptKind | 'body' };

export function scriptPaths(text: string): PathRef[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: PathRef[] = [];
  let afterRequest = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.trim();
    if (t.startsWith('###')) { afterRequest = false; continue; }
    const m = /^(\s*)([<>])\s*(\S.*?)\s*$/.exec(l);
    if (m && m[3].startsWith('{%')) {
      // inline {% … %}: lewati sampai penutup
      if (!m[3].includes('%}')) while (i + 1 < lines.length && !lines[++i].includes('%}'));
      continue;
    }
    if (m) {
      const start = l.indexOf(m[3], m[1].length + 1);
      out.push({ path: m[3], line: i, start, end: start + m[3].length, kind: m[2] === '>' ? 'post' : afterRequest ? 'body' : 'pre' });
      continue;
    }
    if (t !== '' && !/^(#|\/\/|@[\w.-]+\s*=)/.test(t)) afterRequest = true;
  }
  return out;
}

/** path untuk baris `<` / `>`: relatif ke folder .http, diawali ./ atau ../, pemisah / */
export function relScriptPath(httpDir: string, file: string): string {
  const rel = relative(httpDir, file).split(sep).join('/');
  return rel.startsWith('../') ? rel : `./${rel}`;
}

/** file / folder `from` dipindah ke `to`: path di baris `<` / `>` yang menunjuk ke sana ditulis ulang */
export function renameEdits(text: string, httpDir: string, from: string, to: string): { line: number; start: number; end: number; text: string }[] {
  return scriptPaths(text).flatMap((p) => {
    const abs = resolve(httpDir, p.path);
    if (abs !== from && !abs.startsWith(from + sep)) return [];
    return [{ line: p.line, start: p.start, end: p.end, text: relScriptPath(httpDir, to + abs.slice(from.length)) }];
  });
}

/** isi awal file script baru (Quick Fix Create file, + Add script) */
export const scriptTemplate = (kind: ScriptKind): string => kind === 'pre'
  ? '// Before request: runs before the request is sent. Throw to stop the request.\n// httpme.request.headers.set(\'X-Request-Id\', crypto.randomUUID());\n'
  : '// After response: runs after the response is received.\n// httpme.test(\'Status is 200\', () => httpme.expect(httpme.response.status).toBe(200));\n';

// ---- runner node:vm: konteks baru per run, API httpme.*, console ditangkap ----
export type KV = { get(k: string): string | null | undefined; set(k: string, v: string): void; unset(k: string): void; has(k: string): boolean };
export type ScriptRequest = { method: string; url: string; headers: [string, string][]; body: string | Buffer | undefined };
export type ScriptResponse = { status: number; headers: [string, string][]; body: string; time: number };
export type ScriptContext = {
  /** diubah langsung oleh script pre (method, url, header, body) */ request: ScriptRequest;
  /** hanya post */ response?: ScriptResponse;
  environment: KV;
  /** variable sementara satu request (pre → post), prioritas tertinggi {{var}} */ vars: Map<string, string>;
  cookies: { get(name: string): string | undefined; all(): { name: string; value: string }[] };
};
export type TestResult = { name: string; passed: boolean; error?: string };
export type ConsoleLine = { level: 'log' | 'info' | 'warn' | 'error'; text: string };
export type RunResult = { error?: string; skipped: boolean; tests: TestResult[]; console: ConsoleLine[] };
export type RunOptions = {
  /** path file script (nama di stack trace, dasar require lokal) */ file: string;
  /** folder repository: batas require .js lokal */ root: string;
  signal?: AbortSignal;
  /** batas waktu: kode sinkron (vm timeout) & total termasuk await; default 5 s / 30 s */ limits?: { syncMs: number; totalMs: number };
};
const LIMITS = { syncMs: 5000, totalMs: 30000 };
const MODULES = ['crypto', 'buffer', 'url', 'querystring', 'util'];

const message = (e: unknown): string => (e && typeof e === 'object' && 'message' in e ? String((e as Error).message) : String(e));
/** pesan + baris di file script (stack dari realm vm bukan instanceof Error host) */
function scriptError(e: unknown, file: string): string {
  const stack = e && typeof e === 'object' && 'stack' in e ? String((e as Error).stack) : '';
  const at = stack.split('\n').find((l) => l.includes(file));
  const loc = at && /\(?([^()\s]+:\d+:\d+)\)?\s*$/.exec(at)?.[1];
  const name = e && typeof e === 'object' && 'name' in e ? String((e as Error).name) : 'Error';
  return `${name}: ${message(e)}${loc ? ` (${loc})` : ''}`;
}

const headerApi = (list: [string, string][]) => ({
  get: (n: string) => list.find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1],
  has: (n: string) => list.some(([k]) => k.toLowerCase() === n.toLowerCase()),
  set(n: string, v: unknown) {
    const i = list.findIndex(([k]) => k.toLowerCase() === n.toLowerCase());
    if (i >= 0) list[i] = [list[i][0], String(v)]; else list.push([n, String(v)]);
  },
  remove(n: string) { for (let i = list.length - 1; i >= 0; i--) if (list[i][0].toLowerCase() === n.toLowerCase()) list.splice(i, 1); },
  all: () => list.map(([k, v]) => ({ name: k, value: v })),
});

/** expect(x).toBe(…) gaya Jest, dengan .not */
function expectApi(actual: unknown, negate = false): Record<string, unknown> {
  const assert = require('node:assert') as typeof import('node:assert');
  const check = (ok: boolean, msg: string) => { if (ok === negate) throw new assert.AssertionError({ message: `${negate ? 'Not: ' : ''}${msg}` }); };
  const show = (v: unknown) => require('node:util').inspect(v) as string;
  const deepEq = (a: unknown, b: unknown) => { try { assert.deepEqual(a, b); return true; } catch { return false; } };
  const api = {
    toBe: (e: unknown) => check(Object.is(actual, e), `expected ${show(actual)} to be ${show(e)}`),
    toEqual: (e: unknown) => check(deepEq(actual, e), `expected ${show(actual)} to equal ${show(e)}`),
    toContain: (e: unknown) => check((typeof actual === 'string' || Array.isArray(actual)) && actual.includes(e as never), `expected ${show(actual)} to contain ${show(e)}`),
    toMatch: (e: RegExp | string) => check(typeof actual === 'string' && (typeof e === 'string' ? actual.includes(e) : new RegExp(e.source, e.flags).test(actual)), `expected ${show(actual)} to match ${show(e)}`),
    toBeTruthy: () => check(!!actual, `expected ${show(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, `expected ${show(actual)} to be falsy`),
    toBeLessThan: (e: number) => check(Number(actual) < e, `expected ${show(actual)} to be less than ${e}`),
    toBeGreaterThan: (e: number) => check(Number(actual) > e, `expected ${show(actual)} to be greater than ${e}`),
    toHaveProperty: (p: string) => check(actual !== null && typeof actual === 'object' && p in (actual as object), `expected ${show(actual)} to have property ${p}`),
  };
  return negate ? api : { ...api, not: expectApi(actual, true) };
}

export async function runScript(code: string, opts: RunOptions, c: ScriptContext): Promise<RunResult> {
  const vm = require('node:vm') as typeof import('node:vm');
  const { inspect, format } = require('node:util') as typeof import('node:util');
  const result: RunResult = { skipped: false, tests: [], console: [] };
  const pending: Promise<void>[] = [];
  const line = (level: ConsoleLine['level']) => (...args: unknown[]) =>
    void result.console.push({ level, text: args.map((a) => (typeof a === 'string' ? a : a && typeof a === 'object' && 'stack' in a ? String((a as Error).stack) : inspect(a))).join(' ') });
  const test = (name: string, fn: () => unknown) => {
    // slot dipesan saat dipanggil: urutan hasil = urutan httpme.test, juga untuk test async
    const i = result.tests.push({ name: String(name), passed: false }) - 1;
    const done = (error?: unknown) => { result.tests[i] = { name: String(name), passed: error === undefined, ...(error === undefined ? {} : { error: message(error) }) }; };
    try {
      const p = fn();
      if (p && typeof (p as Promise<unknown>).then === 'function') pending.push(Promise.resolve(p).then(() => done(), (e) => done(e ?? 'failed')));
      else done();
    } catch (e) { done(e ?? 'failed'); } // test gagal = hasil di tab Tests, bukan error program
  };
  const res = c.response;
  const httpme = {
    request: Object.defineProperties({ headers: headerApi(c.request.headers) }, {
      method: { get: () => c.request.method, set: (v) => { c.request.method = String(v).toUpperCase(); }, enumerable: true },
      url: { get: () => c.request.url, set: (v) => { c.request.url = String(v); }, enumerable: true },
      body: { get: () => (Buffer.isBuffer(c.request.body) ? c.request.body.toString('utf8') : c.request.body), set: (v) => { c.request.body = v === undefined || v === null ? undefined : String(v); }, enumerable: true },
    }),
    response: res && { status: res.status, time: res.time, headers: headerApi(res.headers), text: () => res.body, json: () => JSON.parse(res.body), body: res.body },
    environment: { get: (k: string) => c.environment.get(k) ?? undefined, set: (k: string, v: unknown) => c.environment.set(k, String(v)), unset: (k: string) => c.environment.unset(k), has: (k: string) => c.environment.has(k) },
    vars: { get: (k: string) => c.vars.get(k), set: (k: string, v: unknown) => void c.vars.set(k, String(v)), unset: (k: string) => void c.vars.delete(k), has: (k: string) => c.vars.has(k) },
    cookies: c.cookies,
    test, expect: (v: unknown) => expectApi(v),
    skip: () => { result.skipped = true; },
  };
  const sandbox: Record<string, unknown> = vm.createContext({
    httpme, console: { log: line('log'), info: line('info'), warn: line('warn'), error: line('error'), debug: line('log') },
    crypto: require('node:crypto'), Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, structuredClone,
    setTimeout, clearTimeout, format,
  });
  const limits = opts.limits ?? LIMITS;
  const runOpts = { timeout: limits.syncMs };
  const cache = new Map<string, unknown>();
  /** require terbatas: modul aman + .js lokal di dalam repository (dijalankan di konteks yang sama) */
  const makeRequire = (fromDir: string) => (id: string): unknown => {
    const bare = String(id).replace(/^node:/, '');
    if (MODULES.includes(bare)) return require(`node:${bare}`);
    const f = /^\.\.?\//.test(id) ? resolve(fromDir, /\.js$/.test(id) ? id : `${id}.js`) : undefined;
    const rel = f && relative(opts.root, f);
    if (!f || !rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`require('${id}') is not allowed in http.me scripts (allowed: ${MODULES.join(', ')} and .js files inside the repository)`);
    }
    if (cache.has(f)) return cache.get(f);
    const mod = { exports: {} as unknown };
    cache.set(f, mod.exports);
    const src = (require('node:fs') as typeof import('node:fs')).readFileSync(f, 'utf8');
    const fn = new vm.Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: f }).runInContext(sandbox, runOpts) as Function;
    fn(mod.exports, makeRequire(dirname(f)), mod, f, dirname(f));
    cache.set(f, mod.exports);
    return mod.exports;
  };
  sandbox.require = makeRequire(dirname(opts.file));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (opts.signal?.aborted) throw new Error('Cancelled');
    // satu baris pembungkus: nomor baris di stack trace = baris file
    const wrapped = `(async () => {${code}\n})()`;
    // shortcut: loop tak berujung di callback setTimeout / setelah await tidak bisa diputus vm, hanya kena batas total (eksekusi tetap jalan)
    const run = (async () => {
      await (new vm.Script(wrapped, { filename: opts.file }).runInContext(sandbox, runOpts) as Promise<unknown>);
      await Promise.all(pending);
    })();
    await Promise.race([
      run,
      new Promise((_ok, fail) => { timer = setTimeout(() => fail(new Error(`Script timed out after ${limits.totalMs / 1000} s`)), limits.totalMs); }),
      new Promise((_ok, fail) => { onAbort = () => fail(new Error('Cancelled')); opts.signal?.addEventListener('abort', onAbort); }),
    ]);
  } catch (e) {
    // error script = hasil (tab Tests); pemanggil mencatat log ERROR
    const m = message(e);
    result.error = m === 'Cancelled' ? m : /^Script execution timed out after (\d+)ms/.test(m) ? `Script timed out after ${limits.syncMs} ms (synchronous code)` : scriptError(e, opts.file);
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
  return result;
}

// ---- rantai script satu tahap (pre / post) ----
export type ChainResult = { tests: TestResult[]; console: ConsoleLine[]; error?: string; skipped: boolean };
export type ChainOptions = { root: string; httpFile: string; read(file: string): Promise<string>; signal?: AbortSignal; limits?: RunOptions['limits'] };

/** jalankan rantai berurutan dengan konteks yang sama; script yang gagal menghentikan rantai */
export async function runChain(chain: readonly ScriptRef[], o: ChainOptions, c: ScriptContext): Promise<ChainResult> {
  const out: ChainResult = { tests: [], console: [], skipped: false };
  for (const ref of chain) {
    const name = 'file' in ref ? relScriptPath(dirname(o.httpFile), ref.file) : 'inline script';
    let code: string;
    try {
      code = 'file' in ref ? await o.read(ref.file) : ref.inline;
    } catch (e) {
      // file tidak terbaca = error rantai (pemanggil mencatat log ERROR)
      out.error = `${name}: ${message(e)}`;
      return out;
    }
    const r = await runScript(code, { file: 'file' in ref ? ref.file : o.httpFile, root: o.root, signal: o.signal, limits: o.limits }, c);
    out.tests.push(...r.tests);
    out.console.push(...r.console);
    out.skipped ||= r.skipped;
    if (r.error) { out.error = r.error === 'Cancelled' ? r.error : `${name}: ${r.error}`; return out; }
  }
  return out;
}

/** request untuk script pre: header aktif, body teks (body `< ./file` = undefined) */
export const toScriptRequest = (r: ParsedRequest): ScriptRequest => ({
  method: r.method, url: r.url, headers: r.headers.filter((h) => h.enabled).map((h): [string, string] => [h.name, h.value]), body: r.bodyFile ? undefined : r.body || undefined,
});

/** perubahan script pre kembali ke ParsedRequest (header nonaktif tetap; body diganti = body file dilepas) */
export function applyScriptRequest(r: ParsedRequest, s: ScriptRequest): ParsedRequest {
  const before = toScriptRequest(r).body;
  const body = Buffer.isBuffer(s.body) ? s.body.toString('utf8') : s.body;
  const changed = body !== before;
  return {
    ...r, method: s.method, url: s.url,
    headers: [...s.headers.map(([name, value]) => ({ name, value, enabled: true })), ...r.headers.filter((h) => !h.enabled)],
    ...(changed ? { body: body ?? '', bodyFile: undefined } : {}),
  };
}

/**
 * httpme.environment untuk script: set / unset langsung terlihat, perubahan dikumpulkan (take) lalu disimpan pemanggil
 * sebagai current value (workspace state / SecretStorage), file Environment di repo tidak diubah
 */
export function overlayKV(base: ReadonlyMap<string, string | null>, writable: boolean): { kv: KV; take(): Map<string, string | undefined> } {
  const view = new Map(base);
  let changes = new Map<string, string | undefined>();
  const write = (k: string, v: string | undefined) => {
    if (!writable) throw new Error('No active Environment: select an Environment to use httpme.environment.set / unset');
    changes.set(k, v);
    if (v === undefined) view.delete(k); else view.set(k, v);
  };
  return {
    kv: { get: (k) => view.get(k), has: (k) => view.has(k) && view.get(k) !== null, set: (k, v) => write(k, v), unset: (k) => write(k, undefined) },
    take() { const out = changes; changes = new Map(); return out; },
  };
}

/** CodeLens folder script: jumlah request (blok) di .http folder itu & subfoldernya yang menjalankannya */
export function appliesTo(scriptFile: string, files: readonly { path: string; text: string }[]): number {
  const dir = dirname(scriptFile);
  const kind: ScriptKind = /post-request\.js$/i.test(scriptFile) ? 'post' : 'pre';
  let n = 0;
  for (const f of files) {
    if (!f.path.startsWith(dir + sep)) continue;
    for (const b of splitBlocks(f.text)) {
      const r = parseRequest(b.text);
      if (!r.noScripts && !(kind === 'pre' ? r.noPre : r.noPost)) n++;
    }
  }
  return n;
}

/** pindah satu item (◀ ▶ / drag); indeks salah = salinan tanpa perubahan */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  out.splice(to, 0, ...out.splice(from, 1));
  return out;
}

/** ganti script `<` (pre) / `>` (post) berpath dengan daftar file (path absolut → relatif ke .http); inline {% %} tetap */
export function withScriptLines(r: ParsedRequest, kind: ScriptKind, httpDir: string, files: readonly string[]): ParsedRequest {
  const key = kind === 'pre' ? 'preScripts' : 'postScripts';
  return { ...r, [key]: [...files.map((f) => relScriptPath(httpDir, f)), ...r[key].filter((x) => x.startsWith('{%'))] };
}

/** item tab Scripts › Runs in order: folder script, baris `<` / `>`, inline, lalu This request (file milik request, boleh belum ada) */
export type ChainItem = { file: string; source: 'folder' | 'line' | 'inline' | 'own'; exists: boolean; code?: string };

export async function chainItems(root: string, httpFile: string, r: ParsedRequest, kind: ScriptKind): Promise<ChainItem[]> {
  const out: ChainItem[] = [];
  for (const dir of folders(root, httpFile)) {
    const f = join(dir, `${kind}-request.js`);
    if (await exists(f)) out.push({ file: f, source: 'folder', exists: true });
  }
  for (const sc of kind === 'pre' ? r.preScripts : r.postScripts) {
    const inline = /^\{%([\s\S]*)%\}$/.exec(sc);
    if (inline) { out.push({ file: '', source: 'inline', exists: true, code: inline[1] }); continue; }
    const f = resolve(dirname(httpFile), sc);
    out.push({ file: f, source: 'line', exists: await exists(f) });
  }
  const own = ownScript(httpFile, kind);
  out.push({ file: own, source: 'own', exists: await exists(own) });
  return out;
}
