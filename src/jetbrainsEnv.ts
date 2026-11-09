// import http-client.env.json (+ http-client.private.env.json) JetBrains -> Environment http.me (tanpa vscode)
import type { EnvVar } from './environments';

export type ImportedEnv = { name: string; vars: EnvVar[]; /** nilai Secret (private): pemanggil menyimpannya di SecretStorage, tidak pernah ke file */ secrets: Record<string, string> };

function read(text: string | undefined, label: string): Record<string, Record<string, unknown>> {
  if (text === undefined) return {};
  let j: unknown;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`${label} is not valid JSON: ${(e as Error).message}`); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${label}: expected an object of environments`);
  return Object.fromEntries(Object.entries(j).filter((e): e is [string, Record<string, unknown>] => !!e[1] && typeof e[1] === 'object' && !Array.isArray(e[1])));
}
const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

export function fromJetBrainsEnv(publicJson: string, privateJson?: string): ImportedEnv[] {
  const pub = read(publicJson, 'http-client.env.json');
  const priv = read(privateJson, 'http-client.private.env.json');
  const names = [...new Set([...Object.keys(pub), ...Object.keys(priv)])];
  const out = names.map((name): ImportedEnv => {
    const secrets: Record<string, string> = {};
    const vars = new Map<string, EnvVar>();
    for (const [k, v] of Object.entries(pub[name] ?? {})) vars.set(k, { key: k, value: text(v) });
    for (const [k, v] of Object.entries(priv[name] ?? {})) { vars.set(k, { key: k, value: null, secret: true }); secrets[k] = text(v); }
    return { name, vars: [...vars.values()], secrets };
  });
  // aturan key sama: tiap Environment punya semua key, yang tidak ada = NULL
  const keys = new Map<string, boolean>();
  for (const e of out) for (const v of e.vars) keys.set(v.key, (keys.get(v.key) ?? false) || !!v.secret);
  for (const e of out) for (const [k, secret] of keys) if (!e.vars.some((v) => v.key === k)) e.vars.push({ key: k, value: null, ...(secret ? { secret: true } : {}) });
  return out;
}

export type ExportEnv = { name: string; vars: readonly EnvVar[]; secrets: Readonly<Record<string, string>> };

/** nilai non-secret -> file utama; nilai Secret hanya ke file private (dan hanya bila includeSecrets) */
export function toJetBrainsEnv(envs: readonly ExportEnv[], o: { includeSecrets: boolean }): { publicJson: string; privateJson?: string } {
  const pub: Record<string, Record<string, string>> = {};
  const priv: Record<string, Record<string, string>> = {};
  for (const e of envs) {
    pub[e.name] = {};
    priv[e.name] = {};
    for (const v of e.vars) {
      if (v.enabled === false) continue;
      if (v.secret) { if (o.includeSecrets && e.secrets[v.key] !== undefined) priv[e.name][v.key] = e.secrets[v.key]; } else if (v.value !== null) pub[e.name][v.key] = v.value;
    }
  }
  const hasPriv = Object.values(priv).some((x) => Object.keys(x).length);
  return { publicJson: `${JSON.stringify(pub, null, 2)}\n`, ...(hasPriv ? { privateJson: `${JSON.stringify(priv, null, 2)}\n` } : {}) };
}
