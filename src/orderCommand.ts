// ubah urutan satu item Collections (tanpa vscode): dipakai sidebar & Dashboard; hasil disimpan lewat collectionOrder
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { applyOrder, readOrder, saveFolderOrder, shiftNames } from './collectionOrder';
import { shouldSkipDir } from './dashboard';
import { moveInOrder } from './sidebarModel';

/** shift: geser satu langkah; before: letakkan sebelum saudara bernama itu (sejenis: folder dengan folder, file dengan file) */
export type OrderOp = { shift: -1 | 1 } | { before: string };

/** true bila urutan berubah (dan tersimpan) */
export async function reorderChild(root: string, rel: string, op: OrderOp): Promise<boolean> {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!parts.length || parts.includes('..')) throw new Error('Invalid path.');
  const name = parts[parts.length - 1];
  const folder = parts.slice(0, -1).join('/');
  const dir = join(root, folder);
  const isDir = (await fs.stat(join(dir, name))).isDirectory();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const list = (dirs: boolean) => entries.filter((e) => (dirs ? e.isDirectory() && !shouldSkipDir(e.name) : e.isFile() && /\.http$/i.test(e.name))).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  const saved = (await readOrder(root))[folder];
  const folders = applyOrder(list(true), (s) => s, saved);
  const files = applyOrder(list(false), (s) => s, saved);
  const group = isDir ? folders : files;
  if (!group.includes(name)) throw new Error(`${basename(rel)} is not in the Collections list.`);
  const next = 'shift' in op ? shiftNames(group, name, op.shift) : moveInOrder(group, [name], op.before);
  if (next.join('\0') === group.join('\0')) return false;
  await saveFolderOrder(root, folder, isDir ? [...next, ...files] : [...folders, ...next]);
  return true;
}
