// urutan kustom isi folder Collections (tanpa vscode): .httpme/order.json di root workspace, ikut commit
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseFormatted, stringifyFormatted } from './format';

export const ORDER_FILE = '.httpme/order.json';
/** path folder relatif ('' = root, '/') → nama anak (basename) sesuai urutan pilihan user */
export type OrderMap = Record<string, string[]>;

/** nama tersimpan dulu sesuai urutannya; yang tak tercatat di belakang (urutan asal); nama basi diabaikan */
export function applyOrder<T>(items: readonly T[], name: (t: T) => string, saved: readonly string[] | undefined): T[] {
  if (!saved?.length) return [...items];
  const rank = new Map(saved.map((n, i) => [n, i]));
  return items.map((x, i) => ({ x, i })).sort((a, b) => (rank.get(name(a.x)) ?? saved.length + a.i) - (rank.get(name(b.x)) ?? saved.length + b.i)).map(({ x }) => x);
}

/** geser `target` satu langkah (-1 atas, 1 bawah); di ujung / tak ada = tidak berubah */
export function shiftNames(shown: readonly string[], target: string, dir: -1 | 1): string[] {
  const out = [...shown];
  const i = out.indexOf(target);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export function parseOrder(text: string, fileName = ORDER_FILE): OrderMap {
  const raw = parseFormatted<{ order?: unknown }>(text, fileName).order;
  const out: OrderMap = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

/** file belum ada = urutan default (kosong); file rusak = error (dilaporkan pemanggil) */
export async function readOrder(root: string): Promise<OrderMap> {
  let text: string;
  try {
    text = await fs.readFile(join(root, ORDER_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  return parseOrder(text);
}

/** simpan urutan satu folder; daftar kosong = hapus kuncinya */
export async function saveFolderOrder(root: string, folder: string, names: readonly string[]): Promise<void> {
  const map = await readOrder(root);
  if (names.length) map[folder] = [...names]; else delete map[folder];
  const file = join(root, ORDER_FILE);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, stringifyFormatted({ order: map }), 'utf8');
}
