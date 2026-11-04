// Environment = .httpme/environments/<nama>.json (tanpa vscode): baca/tulis, validasi, key sama di semua Environment
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ttlCache } from './memo';
import { environmentFileName } from './store';
import { parseFormatted, stringifyFormatted } from './format';
import type { VarValue } from './vars';

export const ENV_DIR = '.httpme/environments';
/** value null = NULL (belum diisi); secret: nilai di SecretStorage, file hanya berisi nama */
export type EnvVar = { key: string; value: VarValue; secret?: boolean; enabled?: boolean };

export function parseEnvironment(text: string, fileName = 'Environment file'): EnvVar[] {
  const json = parseFormatted<{ variables?: unknown }>(text, fileName);
  if (!Array.isArray(json.variables)) throw new Error(`${fileName}: expected a "variables" list`);
  return json.variables.filter((x) => x && typeof x === 'object' && typeof x.key === 'string').map((x: Record<string, unknown>): EnvVar => {
    const out: EnvVar = { key: x.key as string, value: x.secret === true || x.value === null || x.value === undefined ? null : String(x.value) };
    if (x.secret === true) out.secret = true;
    if (x.enabled === false) out.enabled = false;
    return out;
  });
}

export function serializeEnvironment(vars: readonly EnvVar[]): string {
  const variables = vars.map((x) => ({ key: x.key, ...(x.secret ? { secret: true } : { value: x.value }), ...(x.enabled === false ? { enabled: false } : {}) }));
  return stringifyFormatted({ variables });
}

/** nama kosong / duplikat: baris ditandai merah, editor tidak menyimpan */
export function validateVars(vars: readonly EnvVar[]): { index: number; message: string }[] {
  const seen = new Set<string>();
  const out: { index: number; message: string }[] = [];
  vars.forEach((x, index) => {
    const k = x.key.trim();
    if (!k) out.push({ index, message: 'Variable name is required' });
    else if (seen.has(k)) out.push({ index, message: `Duplicate variable "${k}"` });
    seen.add(k);
  });
  return out;
}

/** nilai saat Send: current value (workspace state) bila ada, selain itu initial; secret dari SecretStorage */
export function environmentValues(vars: readonly EnvVar[], current: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string | undefined>>): Map<string, VarValue> {
  const m = new Map<string, VarValue>();
  for (const x of vars) {
    if (x.enabled === false) continue;
    m.set(x.key, x.secret ? secrets[x.key] ?? null : current[x.key] ?? x.value);
  }
  return m;
}

/** Persist all: current -> initial; secret tidak ikut */
export const persistAll = (vars: readonly EnvVar[], current: Readonly<Record<string, string>>): EnvVar[] =>
  vars.map((x) => (!x.secret && x.key in current ? { ...x, value: current[x.key] } : x));

// ---------- operasi key murni (dipakai untuk semua Environment sekaligus) ----------
export const withKey = (vars: readonly EnvVar[], key: string, secret = false): EnvVar[] =>
  vars.some((x) => x.key === key) ? [...vars] : [...vars, { key, value: null, ...(secret ? { secret: true } : {}) }];
export const renamedKey = (vars: readonly EnvVar[], from: string, to: string): EnvVar[] => vars.map((x) => (x.key === from ? { ...x, key: to } : x));
export const withoutKey = (vars: readonly EnvVar[], key: string): EnvVar[] => vars.filter((x) => x.key !== key);
export const clearedKey = (vars: readonly EnvVar[], key: string): EnvVar[] => vars.map((x) => (x.key === key ? { ...x, value: null } : x));
/** jadi secret: nilai keluar dari file (pemanggil memindahkannya ke SecretStorage) */
export const withSecret = (vars: readonly EnvVar[], key: string, secret: boolean): EnvVar[] => vars.map((x) => {
  if (x.key !== key) return x;
  const { secret: _old, ...rest } = x;
  return secret ? { ...rest, value: null, secret: true } : rest;
});

// ---------- file ----------
const fileOf = (dir: string, name: string) => {
  const f = environmentFileName(name);
  if (typeof f !== 'string') throw new Error(f.error);
  return join(dir, f);
};
const exists = (p: string) => fs.stat(p).then(() => true, () => false); // stat gagal = belum ada (bukan error)
const parsed = ttlCache(30_000);

export async function listEnvironments(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return [] as string[]; throw e; });
  return names.filter((n) => /\.json$/i.test(n)).map((n) => n.replace(/\.json$/i, '')).sort((a, b) => a.localeCompare(b));
}

/** isi terparse (ttlCache 30 dtk); fresh = baca ulang (watcher file berubah) */
export const readEnvironment = (dir: string, name: string, fresh = false): Promise<EnvVar[]> =>
  parsed.get(fileOf(dir, name), async () => parseEnvironment(await fs.readFile(fileOf(dir, name), 'utf8'), `${name}.json`), fresh);

export async function writeEnvironment(dir: string, name: string, vars: readonly EnvVar[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = fileOf(dir, name);
  await fs.writeFile(file, serializeEnvironment(vars));
  await parsed.get(file, async () => vars.map((x) => ({ ...x })), true);
}

/** terapkan fn ke semua Environment (kecuali `except` = yang sedang diedit); kembalikan nama yang berubah */
export async function updateAll(dir: string, fn: (vars: EnvVar[]) => EnvVar[], except?: string): Promise<string[]> {
  const changed: string[] = [];
  for (const name of await listEnvironments(dir)) {
    if (name === except) continue;
    const before = await readEnvironment(dir, name, true);
    const after = fn(before);
    if (serializeEnvironment(after) === serializeEnvironment(before)) continue;
    await writeEnvironment(dir, name, after);
    changed.push(name);
  }
  return changed;
}

/** gabungan key semua Environment (urutan kemunculan pertama) + flag secret */
function unionKeys(envs: readonly { vars: readonly EnvVar[] }[]): Map<string, boolean> {
  const keys = new Map<string, boolean>();
  for (const e of envs) for (const x of e.vars) keys.set(x.key, (keys.get(x.key) ?? false) || !!x.secret);
  return keys;
}

/** Environment baru: semua key yang sudah ada, nilai NULL */
export async function createEnvironment(dir: string, name: string, vars?: readonly EnvVar[]): Promise<string> {
  const file = fileOf(dir, name);
  if (await exists(file)) throw new Error(`Environment "${name.trim()}" already exists`);
  const envs = await Promise.all((await listEnvironments(dir)).map(async (n) => ({ vars: await readEnvironment(dir, n, true) })));
  let out = vars ? [...vars] : [];
  for (const [key, secret] of unionKeys(envs)) out = withKey(out, key, secret);
  await writeEnvironment(dir, name.trim().replace(/\.json$/i, ''), out);
  // key baru dari `vars` (import) ikut ke Environment lain dengan NULL
  for (const x of out) await updateAll(dir, (o) => withKey(o, x.key, !!x.secret), name.trim().replace(/\.json$/i, ''));
  return file;
}

export async function duplicateEnvironment(dir: string, from: string, to: string): Promise<string> {
  const file = fileOf(dir, to);
  if (await exists(file)) throw new Error(`Environment "${to.trim()}" already exists`);
  await fs.copyFile(fileOf(dir, from), file, fs.constants?.COPYFILE_EXCL);
  return file;
}

export async function renameEnvironment(dir: string, from: string, to: string): Promise<string> {
  const file = fileOf(dir, to);
  if (file === fileOf(dir, from)) return file;
  if (await exists(file)) throw new Error(`Environment "${to.trim()}" already exists`);
  await fs.rename(fileOf(dir, from), file);
  return file;
}

export const deleteEnvironment = (dir: string, name: string): Promise<void> => fs.rm(fileOf(dir, name));

// ---------- key tidak sama dari luar (edit manual / git pull) ----------
export function keyMismatch(envs: readonly { name: string; vars: readonly EnvVar[] }[]): { name: string; missing: string[] }[] {
  const keys = [...unionKeys(envs).keys()];
  return envs.map((e) => ({ name: e.name, missing: keys.filter((k) => !e.vars.some((x) => x.key === k)) })).filter((m) => m.missing.length);
}

export const mismatchMessage = (m: readonly { name: string; missing: string[] }[]): string =>
  m.map((x) => `${x.missing.length} key${x.missing.length === 1 ? '' : 's'} missing in Environment "${x.name}"`).join(', ');

/** Sync: key yang hilang ditambahkan dengan NULL (flag secret ikut) */
export function syncKeys(vars: readonly EnvVar[], envs: readonly { vars: readonly EnvVar[] }[]): EnvVar[] {
  let out = [...vars];
  for (const [key, secret] of unionKeys(envs)) out = withKey(out, key, secret);
  return out;
}

// ---------- import Postman environment ----------
export function fromPostmanEnvironment(text: string): { name: string; vars: EnvVar[]; secrets: Record<string, string> } {
  let json: { name?: unknown; values?: unknown };
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`The file is not valid JSON: ${(e as Error).message}`);
  }
  if (!json || typeof json.name !== 'string' || !Array.isArray(json.values)) throw new Error('The file is not a Postman environment (expected "name" and "values")');
  const secrets: Record<string, string> = {};
  const vars = json.values.filter((x) => x && typeof x.key === 'string').map((x: Record<string, unknown>): EnvVar => {
    const value = x.value === undefined || x.value === null ? null : String(x.value);
    const out: EnvVar = x.type === 'secret' ? { key: x.key as string, value: null, secret: true } : { key: x.key as string, value };
    if (x.type === 'secret' && value !== null) secrets[x.key as string] = value;
    if (x.enabled === false) out.enabled = false;
    return out;
  });
  return { name: json.name, vars, secrets };
}
