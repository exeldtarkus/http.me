// script pre-request / post-request (tanpa vscode): cari rantai script untuk satu request .http
import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
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

