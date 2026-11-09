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
