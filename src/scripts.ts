// script pre-request / post-request (tanpa vscode): cari rantai script untuk satu request .http
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { ParsedRequest } from './httpFile';

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
 * urutan jalan: `pre-request.js` / `post-request.js` folder teratas → terdekat, lalu baris `<` / `>` atas → bawah.
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
  return out;
}
