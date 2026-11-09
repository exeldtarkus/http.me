// proses export (Fase 5c) tanpa vscode: baca folder collection -> bangun -> validasi -> tulis SEKALI di akhir; bisa dibatalkan
import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { EnvVar } from './environments';
import { buildCollection, type ExportFile } from './exportModel';
import { localPath } from './importFetch';
import { SOURCE_FILE, parseSource } from './importSync';
import { errMsg } from './log';
import { toOpenApi, validateOpenApi, type HistoryResponse, type OpenApiVersion } from './exportOpenapi';
import { toPostman, toPostmanEnvironment, validatePostman } from './exportPostman';
import { parseDoc, stringifyDoc } from './importCommon';
import { toJetBrainsEnv } from './jetbrainsEnv';
import type { VarValue } from './vars';

export type ExportEnv = { name: string; vars: readonly EnvVar[]; secrets: Readonly<Record<string, string>> };
export type ExportBuildOptions = {
  format: 'postman' | OpenApiVersion;
  /** OpenAPI: YAML (library yaml, lazy) */ yaml?: boolean;
  /** file hasil utama (absolut); file Environment ditulis di folder yang sama */ outFile: string;
  translateScripts?: boolean;
  /** sertakan Environments (+ Globals) */ environments?: { list: readonly ExportEnv[]; globals?: ExportEnv; includeSecrets: boolean; jetbrains?: boolean };
  /** OpenAPI: nilai efektif Environment untuk `servers` */ envValues?: readonly { name: string; values: ReadonlyMap<string, VarValue> }[];
  history?: readonly HistoryResponse[];
  /** OpenAPI: spec asli dari `_source.json` */ original?: Record<string, unknown>;
};
export type ExportRunOptions = ExportBuildOptions & {
  /** folder collection (absolut) */ root: string;
  /** true = ikut; path relatif ke folder collection (pemisah `/`) */ include?: (rel: string) => boolean;
};
export type ExportResult = { files: string[]; requests: number; skipped: string[]; warnings: string[] };
export type Built = { out: { path: string; content: string }[]; requests: number; skipped: string[]; warnings: string[] };

export class ExportCancelled extends Error { constructor() { super('Export cancelled'); } }
const SKIP_DIRS = new Set(['node_modules', 'exports']);
const WANTED = /(\.http|\.js|\.httpmekeep|^_variables\.json)$/i;
const MAX_FILE = 5 * 1024 * 1024;
const PREVIEW_MAX = 256 * 1024;

/** request terpilih (path `.http`) + file pendukung (`_auth.http`, script, `_variables.json`, …) di folder induknya */
export function includeSelected(selected: ReadonlySet<string>): (rel: string) => boolean {
  const dirs = new Set<string>(['']);
  for (const p of selected) { let d = p; while (d.includes('/')) { d = d.slice(0, d.lastIndexOf('/')); dirs.add(d); } }
  return (rel) => {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (/\.http$/i.test(rel) && !/(^|\/)_auth\.http$/.test(rel)) return selected.has(rel);
    if (/\.httpmekeep$/.test(rel)) return false;
    return dirs.has(dir);
  };
}

/** spec asli (OpenAPI) dari `_source.json` bertipe file; sumber URL / file hilang = tanpa spec asli + peringatan */
export async function loadOriginal(root: string): Promise<{ doc?: Record<string, unknown>; warning?: string }> {
  let text: string;
  try { text = await fs.readFile(join(root, SOURCE_FILE), 'utf8'); } catch { return { doc: undefined }; } // tanpa _source.json: bukan hasil import, bukan error
  try {
    const src = parseSource(text);
    if (src.type !== 'file') return { doc: undefined, warning: `The source is a ${src.type === 'url' ? 'URL' : src.type}: original schemas are not kept (export from a file source to keep them)` };
    const doc = parseDoc(await fs.readFile(localPath(src.location), 'utf8'));
    return doc && typeof doc === 'object' ? { doc: doc as Record<string, unknown> } : { doc: undefined };
  } catch (e) {
    // tidak dilempar: export tetap jalan; pemanggil (vscode) mencatat peringatan ini ke output channel
    return { doc: undefined, warning: `The original spec could not be read (${errMsg(e)}): schemas are derived from the requests` };
  }
}

/** potong teks pratinjau supaya webview tetap ringan */
export const previewText = (t: string): string => (t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX)}\n… (truncated: the file is ${Math.round(t.length / 1024)} KB, the exported file is complete)` : t);

async function walk(dir: string, root: string, out: string[], signal?: AbortSignal): Promise<void> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (signal?.aborted) throw new ExportCancelled();
    if (e.name.startsWith('.') && e.name !== '.httpmekeep') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(p, root, out, signal); } else if (WANTED.test(e.name)) out.push(relative(root, p).replace(/\\/g, '/'));
  }
}

/** semua file collection yang relevan (path relatif) + isinya */
export async function readCollection(root: string, include?: (rel: string) => boolean, signal?: AbortSignal, onProgress?: (done: number, total: number, path: string) => void): Promise<ExportFile[]> {
  const rels: string[] = [];
  await walk(root, root, rels, signal);
  const picked = include ? rels.filter(include) : rels;
  const files: ExportFile[] = [];
  for (const [i, rel] of picked.entries()) {
    if (signal?.aborted) throw new ExportCancelled();
    const abs = join(root, rel);
    if ((await fs.stat(abs)).size > MAX_FILE) throw new Error(`${rel} is larger than 5 MB`);
    files.push({ path: rel, content: await fs.readFile(abs, 'utf8') });
    onProgress?.(i + 1, picked.length, `${basename(root)}/${rel}`);
  }
  return files;
}

/** bangun + validasi semua file hasil (belum menulis apa pun); dipakai export dan pratinjau */
export function buildExport(name: string, files: readonly ExportFile[], o: ExportBuildOptions): Built {
  const col = buildCollection(name, files);
  const out: { path: string; content: string }[] = [];
  const dir = dirname(o.outFile);
  if (o.format === 'postman') {
    const r = toPostman(col, { translateScripts: o.translateScripts !== false });
    const errs = validatePostman(r.collection);
    if (errs.length) throw new Error(`The generated collection is not valid: ${errs.join('; ')}`);
    out.push({ path: o.outFile, content: stringifyDoc(r.collection, 'json') });
    const ev = o.environments;
    if (ev) {
      if (ev.jetbrains) {
        const j = toJetBrainsEnv(ev.list, { includeSecrets: ev.includeSecrets });
        out.push({ path: join(dir, 'http-client.env.json'), content: j.publicJson });
        if (j.privateJson) out.push({ path: join(dir, 'http-client.private.env.json'), content: j.privateJson });
      } else {
        for (const e of ev.list) out.push({ path: join(dir, `${e.name}.postman_environment.json`), content: stringifyDoc(toPostmanEnvironment(e.name, e.vars, e.secrets, { scope: 'environment', includeSecrets: ev.includeSecrets }), 'json') });
        if (ev.globals) out.push({ path: join(dir, 'globals.postman_globals.json'), content: stringifyDoc(toPostmanEnvironment('Globals', ev.globals.vars, ev.globals.secrets, { scope: 'globals', includeSecrets: ev.includeSecrets }), 'json') });
      }
    }
    return { out, requests: r.requests, skipped: [], warnings: r.warnings };
  }
  const r = toOpenApi(col, { version: o.format, envs: o.envValues ?? [], history: o.history ?? [], ...(o.original ? { original: o.original } : {}) });
  const errs = validateOpenApi(r.doc);
  if (errs.length) throw new Error(`The generated spec is not valid: ${errs.join('; ')}`);
  out.push({ path: o.outFile, content: stringifyDoc(r.doc, o.yaml ? 'yaml' : 'json') });
  return { out, requests: r.requests, skipped: r.skipped, warnings: r.warnings };
}

export async function runExport(o: ExportRunOptions, signal?: AbortSignal, onProgress?: (done: number, total: number, path: string) => void): Promise<ExportResult> {
  const files = await readCollection(o.root, o.include, signal, onProgress);
  const orig = o.format === 'postman' ? {} : await loadOriginal(o.root);
  const built = buildExport(basename(o.root), files, { ...o, ...(orig.doc ? { original: orig.doc } : {}) });
  const warnings = [...built.warnings, ...(orig.warning ? [orig.warning] : [])];
  if (signal?.aborted) throw new ExportCancelled(); // dibatalkan sebelum menulis: tidak ada file ditulis
  const written: string[] = [];
  try {
    for (const f of built.out) {
      await fs.mkdir(dirname(f.path), { recursive: true });
      await fs.writeFile(f.path, f.content);
      written.push(f.path);
    }
  } catch (e) {
    await Promise.all(written.map((p) => fs.rm(p, { force: true }))); // tidak ada file setengah jadi; error diteruskan ke pemanggil yang mencatat log
    throw e;
  }
  return { files: written, requests: built.requests, skipped: built.skipped, warnings };
}
