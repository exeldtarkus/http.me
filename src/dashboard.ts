// data dashboard Collections / Environments / Cookies (tanpa vscode): ringkasan murni dari data yang sudah dibaca
import { parseRequest, splitBlocks } from './httpFile';
import type { EnvVar } from './environments';
import type { Cookie } from './cookieJar';

const SKIP = new Set(['node_modules', 'out', 'dist', 'build', 'target', 'coverage']);
/** folder yang tidak dipindai untuk file .http (dependency, build, folder tersembunyi) */
export const shouldSkipDir = (name: string): boolean => name.startsWith('.') || SKIP.has(name);

export type CollectionSummary = { name: string; requests: number; folders: number; methods: Record<string, number> };
export type CollectionsData = { requests: number; files: number; methods: Record<string, number>; collections: CollectionSummary[] };

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

/** path relatif ke root (pemisah `/`) + isi; collection = folder teratas, file di root = "(root)"; urutan: terbanyak request dulu, "(root)" terakhir */
export function summarizeCollections(files: readonly { path: string; text: string }[]): CollectionsData {
  const by = new Map<string, CollectionSummary & { dirs: Set<string> }>();
  const methods: Record<string, number> = {};
  let requests = 0;
  let count = 0;
  for (const f of files) {
    if (!/\.http$/i.test(f.path) || /(^|\/)_[^/]*$/.test(f.path)) continue;
    const blocks = splitBlocks(f.text);
    const reqs = (blocks.length > 1 ? blocks.map((b) => parseRequest(b.text)) : [parseRequest(f.text)]).filter((r) => r.url !== '');
    if (!reqs.length) continue;
    count++;
    const parts = f.path.split('/');
    const name = parts.length > 1 ? parts[0] : '(root)';
    const c = by.get(name) ?? { name, requests: 0, folders: 0, methods: {}, dirs: new Set<string>() };
    if (parts.length > 2) c.dirs.add(parts.slice(0, -1).join('/'));
    for (const r of reqs) { requests++; c.requests++; bump(c.methods, r.method); bump(methods, r.method); }
    by.set(name, c);
  }
  const collections = [...by.values()].map(({ dirs, ...c }) => ({ ...c, folders: dirs.size }))
    .sort((a, b) => (a.name === '(root)' ? 1 : 0) - (b.name === '(root)' ? 1 : 0) || b.requests - a.requests || a.name.localeCompare(b.name));
  return { requests, files: count, methods, collections };
}

export type EnvironmentSummary = { name: string; active: boolean; variables: number; nulls: number; secrets: number };
export type EnvironmentsData = { active: string | undefined; environments: EnvironmentSummary[]; totalNulls: number };

/** secretSet = key Secret yang sudah punya nilai di SecretStorage per Environment (belum diisi = NULL) */
export function summarizeEnvironments(envs: readonly { name: string; vars: readonly EnvVar[] }[], active: string | undefined, secretSet: Readonly<Record<string, readonly string[]>>): EnvironmentsData {
  const environments = envs.map((e): EnvironmentSummary => ({
    name: e.name, active: e.name === active, variables: e.vars.length, secrets: e.vars.filter((v) => v.secret).length,
    nulls: e.vars.filter((v) => (v.secret ? !(secretSet[e.name] ?? []).includes(v.key) : v.value === null)).length,
  }));
  return { active: environments.some((e) => e.active) ? active : undefined, environments, totalNulls: environments.reduce((n, e) => n + e.nulls, 0) };
}

export type CookieEnvSummary = { env: string; label: string; cookies: number; domains: number; expired: number; session: number };
export type CookiesData = { total: number; environments: CookieEnvSummary[] };

export function summarizeCookies(jars: readonly { env: string; cookies: readonly Cookie[] }[], now: number): CookiesData {
  const environments = jars.map(({ env, cookies }): CookieEnvSummary => ({
    env, label: env ? env : 'No Environment', cookies: cookies.length, domains: new Set(cookies.map((c) => c.domain)).size,
    expired: cookies.filter((c) => c.expires !== undefined && c.expires <= now).length, session: cookies.filter((c) => c.expires === undefined).length,
  }));
  return { total: environments.reduce((n, e) => n + e.cookies, 0), environments };
}
