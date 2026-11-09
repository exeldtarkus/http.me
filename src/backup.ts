// Backup History + request sementara (tab untitled) ke exports/<jenis>-backup/ dan import baliknya (tanpa vscode)
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { addHistory, listHistory } from './history';
import { HTTPME_FORMAT } from './format';

// shortcut: batas "memory" = pertumbuhan isi >= 2 MB sejak backup terakhir, tetap; jadikan setting bila perlu diatur user
export const BACKUP_MAX_BYTES = 2 * 1024 * 1024;
/** jumlah file backup terbaru per jenis yang disimpan */
export const BACKUP_KEEP = 30;

export type BackupKind = 'history' | 'temp';
export type BackupFile = { httpmeFormat: 1; kind: BackupKind; createdAt: number; items: unknown[] };
/** keadaan backup terakhir per jenis (disimpan pemanggil, mis. globalState) */
export type BackupState = { at: number; key: string; size: number };

const two = (n: number) => String(n).padStart(2, '0');
const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
export const backupFileName = (kind: BackupKind, t: number): string => {
  const d = new Date(t);
  return `${kind}-${day(t)}_${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.json`;
};

export function fingerprint(items: unknown[]): { key: string; size: number } {
  const json = JSON.stringify(items);
  return { key: createHash('sha1').update(json).digest('hex'), size: Buffer.byteLength(json) };
}

/** backup bila isi berubah dan (hari baru, atau tumbuh >= batas sejak backup terakhir); isi kosong tidak di-backup */
export function shouldBackup(prev: BackupState | undefined, cur: { key: string; size: number }, now: number): boolean {
  if (cur.size <= 2) return false; // "[]"
  if (!prev) return true;
  if (prev.key === cur.key) return false;
  return day(prev.at) !== day(now) || cur.size - prev.size >= BACKUP_MAX_BYTES;
}

/** tulis satu file backup (0600: berisi request / response) lalu buang yang lebih tua dari BACKUP_KEEP terbaru jenis itu */
export async function writeBackup(dir: string, kind: BackupKind, items: unknown[], now: number): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, backupFileName(kind, now));
  const file = { httpmeFormat: HTTPME_FORMAT, kind, createdAt: now, count: items.length, items }; // count sebelum items: daftar backup cukup membaca awal file
  await fs.writeFile(target, JSON.stringify(file, null, 1), { mode: 0o600 });
  const mine = (await fs.readdir(dir)).filter((n) => n.startsWith(`${kind}-`) && n.endsWith('.json')).sort();
  for (const n of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP))) await fs.rm(join(dir, n), { force: true });
  return target;
}

export function parseBackup(text: string): BackupFile {
  let b: Partial<BackupFile> | undefined;
  try { b = JSON.parse(text) as Partial<BackupFile>; } catch { b = undefined; } // bukan JSON: dilaporkan di bawah sebagai file backup tidak valid
  if (!b || b.httpmeFormat !== HTTPME_FORMAT || (b.kind !== 'history' && b.kind !== 'temp') || !Array.isArray(b.items)) throw new Error('This is not a valid http.me backup file.');
  return b as BackupFile;
}

const isEntry = (x: unknown): x is { id: string; time: number; text: string; method: string; url: string } =>
  !!x && typeof x === 'object' && ['id', 'text', 'method', 'url'].every((k) => typeof (x as Record<string, unknown>)[k] === 'string') && typeof (x as { time?: unknown }).time === 'number';

/** import History: id yang sudah ada dilewati, entri rusak dihitung; batas 200 entri tetap berlaku (yang tertua terbuang) */
export async function importHistoryItems(dir: string, items: unknown[], onProgress?: (done: number, total: number) => void): Promise<{ added: number; skipped: number; invalid: number }> {
  const have = new Set((await listHistory(dir)).map((e) => e.id));
  let added = 0, skipped = 0, invalid = 0;
  let done = 0;
  for (const x of items) {
    if (!isEntry(x)) invalid++;
    else if (have.has(x.id)) skipped++;
    else { await addHistory(dir, x as never); added++; }
    onProgress?.(++done, items.length);
    await new Promise((r) => setImmediate(r)); // beri giliran ke event loop: editor tetap responsif
  }
  return { added, skipped, invalid };
}

export type BackupInfo = { file: string; name: string; kind: BackupKind; at: number; count: number; size: number };

/** daftar file backup di folder-folder itu, terbaru di atas; hanya awal file yang dibaca (bukan seluruh isi) */
export async function listBackups(dirs: string[]): Promise<BackupInfo[]> {
  const out: BackupInfo[] = [];
  for (const dir of dirs) {
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) { // folder belum ada = belum ada backup
      const kind = /^(history|temp)-.*\.json$/.exec(name)?.[1] as BackupKind | undefined;
      if (!kind) continue;
      const file = join(dir, name);
      const fh = await fs.open(file, 'r');
      try {
        const head = Buffer.alloc(300);
        const { bytesRead } = await fh.read(head, 0, 300, 0);
        const text = head.toString('utf8', 0, bytesRead);
        const at = Number(/"createdAt":\s*(\d+)/.exec(text)?.[1]);
        if (!Number.isFinite(at)) continue; // bukan file backup http.me
        out.push({ file, name, kind, at, count: Number(/"count":\s*(\d+)/.exec(text)?.[1] ?? 0), size: (await fh.stat()).size });
      } finally {
        await fh.close();
      }
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
