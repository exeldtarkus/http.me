// variable collection = `_variables.json` di folder collection (tanpa vscode); scope di antara Environment aktif dan Globals
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { parseEnvironment } from './environments';
import type { Scope, VarValue } from './vars';

export const COLLECTION_VARS_FILE = '_variables.json';

/** `_variables.json` terdekat dari folder file .http naik sampai root; undefined = tidak ada. File rusak melempar (pemanggil mencatat log ERROR) */
export async function collectionScope(root: string, httpFile: string): Promise<Scope | undefined> {
  let dir = dirname(httpFile);
  for (;;) {
    const file = join(dir, COLLECTION_VARS_FILE);
    const text = await fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
    if (text !== undefined) {
      const values = new Map<string, VarValue>(parseEnvironment(text, COLLECTION_VARS_FILE).filter((v) => v.enabled !== false && !v.secret).map((v) => [v.key, v.value]));
      return { source: 'collection', name: relative(root, dir) || '.', values };
    }
    const rel = relative(root, dir);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined; // sampai root (atau file di luar root): berhenti
    dir = dirname(dir);
  }
}
