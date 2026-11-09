// proses export (Fase 5c) tanpa vscode: baca folder collection -> bangun -> validasi -> tulis SEKALI di akhir; bisa dibatalkan
import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { EnvVar } from './environments';
import { buildCollection, type ExportFile } from './exportModel';
import { toOpenApi, validateOpenApi, type HistoryResponse, type OpenApiVersion } from './exportOpenapi';
import { toPostman, toPostmanEnvironment, validatePostman } from './exportPostman';
import { stringifyDoc } from './importCommon';
import { toJetBrainsEnv } from './jetbrainsEnv';
import type { VarValue } from './vars';

export type ExportEnv = { name: string; vars: readonly EnvVar[]; secrets: Readonly<Record<string, string>> };
export type ExportRunOptions = {
  /** folder collection (absolut) */ root: string;
  format: 'postman' | OpenApiVersion;
  /** OpenAPI: YAML (library yaml, lazy) */ yaml?: boolean;
  /** file hasil utama (absolut); file Environment ditulis di folder yang sama */ outFile: string;
  /** true = ikut; path relatif ke folder collection (pemisah `/`) */ include?: (rel: string) => boolean;
  translateScripts?: boolean;
  /** sertakan Environments (+ Globals) */ environments?: { list: readonly ExportEnv[]; globals?: ExportEnv; includeSecrets: boolean; jetbrains?: boolean };
  /** OpenAPI: nilai efektif Environment untuk `servers` */ envValues?: readonly { name: string; values: ReadonlyMap<string, VarValue> }[];
  history?: readonly HistoryResponse[];
};
export type ExportResult = { files: string[]; requests: number; skipped: string[]; warnings: string[] };

export class ExportCancelled extends Error { constructor() { super('Export cancelled'); } }
const SKIP_DIRS = new Set(['node_modules', 'exports']);
const WANTED = /(\.http|\.js|\.httpmekeep|^_variables\.json)$/i;
const MAX_FILE = 5 * 1024 * 1024;

async function walk(dir: string, root: string, out: string[], signal?: AbortSignal): Promise<void> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (signal?.aborted) throw new ExportCancelled();
    if (e.name.startsWith('.') && e.name !== '.httpmekeep') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(p, root, out, signal); } else if (WANTED.test(e.name)) out.push(relative(root, p).replace(/\\/g, '/'));
  }
}

export async function runExport(o: ExportRunOptions, signal?: AbortSignal, onProgress?: (done: number, total: number, path: string) => void): Promise<ExportResult> {
  const rels: string[] = [];
  await walk(o.root, o.root, rels, signal);
  const picked = o.include ? rels.filter(o.include) : rels;
  const files: ExportFile[] = [];
  for (const [i, rel] of picked.entries()) {
    if (signal?.aborted) throw new ExportCancelled();
    const abs = join(o.root, rel);
    if ((await fs.stat(abs)).size > MAX_FILE) throw new Error(`${rel} is larger than 5 MB`);
    files.push({ path: rel, content: await fs.readFile(abs, 'utf8') });
    onProgress?.(i + 1, picked.length, `${basename(o.root)}/${rel}`);
  }
  const name = basename(o.root);
  const col = buildCollection(name, files);
  const out: { path: string; content: string }[] = [];
  const dir = dirname(o.outFile);
  let requests: number;
  let skipped: string[] = [];
  let warnings: string[];
  if (o.format === 'postman') {
    const r = toPostman(col, { translateScripts: o.translateScripts !== false });
    const errs = validatePostman(r.collection);
    if (errs.length) throw new Error(`The generated collection is not valid: ${errs.join('; ')}`);
    out.push({ path: o.outFile, content: stringifyDoc(r.collection, 'json') });
    requests = r.requests;
    warnings = r.warnings;
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
  } else {
    const r = toOpenApi(col, { version: o.format, envs: o.envValues ?? [], history: o.history ?? [] });
    const errs = validateOpenApi(r.doc);
    if (errs.length) throw new Error(`The generated spec is not valid: ${errs.join('; ')}`);
    out.push({ path: o.outFile, content: stringifyDoc(r.doc, o.yaml ? 'yaml' : 'json') });
    requests = r.requests;
    skipped = r.skipped;
    warnings = r.warnings;
  }
  if (signal?.aborted) throw new ExportCancelled(); // dibatalkan sebelum menulis: tidak ada file ditulis
  const written: string[] = [];
  try {
    for (const f of out) {
      await fs.mkdir(dirname(f.path), { recursive: true });
      await fs.writeFile(f.path, f.content);
      written.push(f.path);
    }
  } catch (e) {
    await Promise.all(written.map((p) => fs.rm(p, { force: true }))); // tidak ada file setengah jadi; error diteruskan ke pemanggil yang mencatat log
    throw e;
  }
  return { files: written, requests, skipped, warnings };
}
