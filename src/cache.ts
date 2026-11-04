// cache disk per chunk (pola moonage metaCache.ts), tanpa vscode: satu file JSON per key di folder globalStorage/httpme-cache/<jenis>/
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { clearAllCaches } from './memo';

const file = (dir: string, key: string) => join(dir, `${encodeURIComponent(key)}.json`);

/** tulis lewat file sementara + rename: pembaca tidak pernah melihat chunk setengah jadi; 0600 / 0700 (URL & header bisa sensitif) */
export async function writeChunk(dir: string, key: string, value: unknown): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = file(dir, key);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`; // unik per tulis: tulis paralel key sama tidak bentrok
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(tmp, target);
}

/** isi satu chunk; belum ada atau rusak = undefined (dibuat ulang oleh pemakai) */
export async function readChunk<T = unknown>(dir: string, key: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file(dir, key), 'utf8')) as T;
  } catch {
    return undefined; // chunk belum ada / rusak / sedang dihapus: sengaja dilewati, bukan error
  }
}

/** semua chunk [key, isi] di folder; file .tmp dan chunk rusak dilewati */
export async function readChunks<T = unknown>(dir: string): Promise<[string, T][]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]); // folder belum ada = cache kosong
  const out: [string, T][] = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    const key = decodeURIComponent(n.slice(0, -5));
    const v = await readChunk<T>(dir, key);
    if (v !== undefined) out.push([key, v]);
  }
  return out;
}

export const remove = (dir: string, key: string) => fs.rm(file(dir, key), { force: true });

/** buang chunk yang key-nya tidak ada di keep (history > 200, body tab yang sudah ditutup) */
export async function prune(dir: string, keep: Iterable<string>): Promise<void> {
  const names = new Set([...keep].map((k) => `${encodeURIComponent(k)}.json`));
  const files = await fs.readdir(dir).catch(() => [] as string[]); // folder belum ada = tidak ada yang dibuang
  for (const f of files) if (f.endsWith('.json') && !names.has(f)) await fs.rm(join(dir, f), { force: true });
}

/** total ukuran file di folder (rekursif); folder belum ada = 0 */
export async function dirSize(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []); // folder belum ada = 0 byte
  let n = 0;
  for (const e of entries) n += e.isDirectory() ? await dirSize(join(dir, e.name)) : (await fs.stat(join(dir, e.name))).size;
  return n;
}

/** Clear Cache: hapus seluruh folder cache; dibuat ulang saat dipakai lagi */
export const clearCache = (dir: string) => fs.rm(dir, { recursive: true, force: true });

/** alur command Clear Cache: ukuran (MB, 1 desimal) -> ask (konfirmasi) -> hapus folder + semua ttlCache; batal = undefined */
export async function clearCacheFlow(dir: string, ask: (mb: string) => Promise<boolean>): Promise<string | undefined> {
  const mb = ((await dirSize(dir)) / 1024 / 1024).toFixed(1);
  if (!(await ask(mb))) return undefined;
  await clearCache(dir);
  clearAllCaches();
  return mb;
}
