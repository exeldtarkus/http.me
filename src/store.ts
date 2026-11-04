// operasi file collection (tanpa vscode): nama aman, rename / duplicate / move
import { promises as fs } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';

type Err = { error: string };
const ILLEGAL = /[<>:"|?*\u0000-\u001f]/; // karakter yang ditolak Windows (repo dipakai juga dari Windows)
const withHttp = (name: string) => (/\.http$/i.test(name) ? name : `${name}.http`);

/** nama file request baru relatif ke folder tujuan: `.http` ditambahkan, subfolder boleh, tidak boleh keluar folder */
export function requestFileName(input: string): string | Err {
  const name = input.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!name) return { error: 'File name is required' };
  if (name.split('/').some((p) => p === '..' || p === '')) return { error: 'Invalid path: .. and empty folder names are not allowed' };
  if (ILLEGAL.test(name)) return { error: 'Name must not contain < > : " | ? * or control characters' };
  return withHttp(name);
}

/** nama baru di folder yang sama (rename / folder baru): tanpa / dan .., file tetap .http */
export function siblingName(input: string, isFile: boolean): string | Err {
  const name = input.trim();
  if (!name) return { error: 'Name is required' };
  if (/[\\/]/.test(name) || name === '.' || name === '..') return { error: 'Name must not contain / or \\' };
  if (ILLEGAL.test(name)) return { error: 'Name must not contain < > : " | ? * or control characters' };
  return isFile ? withHttp(name) : name;
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false); // stat gagal = belum ada (bukan error)

export async function renamePath(from: string, input: string, isFile = true): Promise<string> {
  const name = siblingName(input, isFile);
  if (typeof name !== 'string') throw new Error(name.error);
  const to = join(dirname(from), name);
  if (to === from) return to;
  if (await exists(to)) throw new Error(`${name} already exists`);
  await fs.rename(from, to);
  return to;
}

/** salinan di folder yang sama: "login copy.http", "login copy 2.http", ... */
export async function duplicateFile(path: string): Promise<string> {
  const ext = extname(path);
  const stem = basename(path, ext);
  for (let n = 1; ; n++) {
    const to = join(dirname(path), `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`);
    if (!(await exists(to))) {
      await fs.copyFile(path, to, fs.constants?.COPYFILE_EXCL);
      return to;
    }
  }
}

/** pindah file / folder ke folder lain (drag & drop): bentrok nama dan folder ke dalam dirinya sendiri ditolak */
export async function movePath(from: string, toDir: string): Promise<string> {
  const to = join(toDir, basename(from));
  if (to === from) return to;
  const rel = relative(from, toDir);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel))) throw new Error(`${basename(from)} cannot be moved into itself`);
  if (await exists(to)) throw new Error(`${basename(from)} already exists in ${basename(toDir)}`);
  await fs.rename(from, to);
  return to;
}

/** penanda folder kosong supaya ikut ter-commit (git tidak menyimpan folder kosong); disembunyikan di tree */
export const KEEP_FILE = '.httpmekeep';

/** New Collection / New Folder: folder sungguhan + .httpmekeep */
export async function createFolder(parent: string, input: string): Promise<string> {
  const name = siblingName(input, false);
  if (typeof name !== 'string') throw new Error(name.error);
  const dir = join(parent, name);
  if (await exists(dir)) throw new Error(`${name} already exists`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, KEEP_FILE), '');
  return dir;
}

/** folder sudah berisi .http: .httpmekeep tidak diperlukan lagi */
export async function dropKeepIfUsed(dir: string): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[]); // folder tidak ada / tidak terbaca: tidak ada yang dibersihkan
  if (names.includes(KEEP_FILE) && names.some((n) => /\.http$/i.test(n))) await fs.rm(join(dir, KEEP_FILE), { force: true });
}

/** nama file Environment: `<nama>.json` di .httpme/environments (tanpa / dan ..) */
export function environmentFileName(input: string): string | Err {
  const name = siblingName(input.trim().replace(/\.json$/i, ''), false);
  return typeof name === 'string' ? `${name}.json` : name;
}
