// substitusi {{variable}} (tanpa vscode): urutan scope = prioritas, NULL (belum diisi) berbeda dengan ''
import { randomUUID } from 'node:crypto';
import type { ParsedRequest } from './httpFile';

export type VarValue = string | null;
export type ScopeSource = 'script' | 'file' | 'environment' | 'collection' | 'globals';
export type Scope = { source: ScopeSource; /** nama Environment */ name?: string; values: ReadonlyMap<string, VarValue> };
export type Lookup = { found: true; value: string; scope: Scope } | { found: false; /** scope yang punya key tapi NULL */ nullIn: Scope[] };

/** nilai pertama yang bukan NULL; NULL di Environment aktif dicari lagi di scope berikutnya (Globals) */
export function lookup(name: string, scopes: readonly Scope[]): Lookup {
  const nullIn: Scope[] = [];
  for (const s of scopes) {
    if (!s.values.has(name)) continue;
    const v = s.values.get(name)!;
    if (v === null) nullIn.push(s);
    else return { found: true, value: v, scope: s };
  }
  return { found: false, nullIn };
}

export const fileScope = (vars: ParsedRequest['vars']): Scope => ({ source: 'file', values: new Map(vars.map((v) => [v.name, v.value])) });

/** jam & random di-inject supaya bisa di-test */
export type Dynamic = { now(): number; random(): number; uuid(): string };
export const realDynamic: Dynamic = { now: Date.now, random: Math.random, uuid: randomUUID };
export const DYNAMIC_NAMES = ['$timestamp', '$isoTimestamp', '$guid', '$uuid', '$randomInt', '$datetime'];

/** `$name [arg…]` → nilai; undefined = variable dinamis tidak dikenal / argumen salah */
export function dynamicValue(expr: string, d: Dynamic = realDynamic): string | undefined {
  const [name, ...args] = expr.trim().split(/\s+/);
  switch (name) {
    case '$timestamp': return args.length ? undefined : String(Math.floor(d.now() / 1000));
    case '$isoTimestamp': return args.length ? undefined : new Date(d.now()).toISOString();
    case '$guid': case '$uuid': return args.length ? undefined : d.uuid();
    case '$randomInt': {
      if (!args.length) return String(Math.floor(d.random() * 1001));
      const [min, max] = args.map(Number);
      if (args.length !== 2 || !Number.isInteger(min) || !Number.isInteger(max) || max <= min) return undefined;
      return String(min + Math.floor(d.random() * (max - min)));
    }
    case '$datetime':
      if (args[0] === 'iso8601' && args.length === 1) return new Date(d.now()).toISOString();
      if (args[0] === 'rfc1123' && args.length === 1) return new Date(d.now()).toUTCString();
      return undefined;
    default: return undefined;
  }
}

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_DEPTH = 5;

export type Substituted = { text: string; nulls: string[]; missing: string[] };

/** ganti semua {{name}} / {{$dynamic}}; yang NULL / tidak ada dibiarkan apa adanya dan dilaporkan */
export function substitute(text: string, scopes: readonly Scope[], d: Dynamic = realDynamic): Substituted {
  const nulls = new Set<string>();
  const missing = new Set<string>();
  const run = (s: string, depth: number): string => s.replace(TOKEN, (whole, raw: string) => {
    if (raw.startsWith('$')) {
      const v = dynamicValue(raw, d);
      if (v === undefined) missing.add(raw.split(/\s+/)[0]);
      return v ?? whole;
    }
    const r = lookup(raw, scopes);
    if (r.found) return depth < MAX_DEPTH ? run(r.value, depth + 1) : r.value; // nilai boleh berisi {{var}} lain
    (r.nullIn.length ? nulls : missing).add(raw);
    return whole;
  });
  return { text: run(text, 0), nulls: [...nulls], missing: [...missing] };
}

/** salinan request siap kirim: URL, header aktif, body (body `< ./file` tidak disentuh) */
export function resolveRequest(r: ParsedRequest, scopes: readonly Scope[], d: Dynamic = realDynamic): { request: ParsedRequest; nulls: string[]; missing: string[] } {
  const nulls = new Set<string>();
  const missing = new Set<string>();
  const sub = (s: string) => {
    const out = substitute(s, scopes, d);
    out.nulls.forEach((n) => nulls.add(n));
    out.missing.forEach((n) => missing.add(n));
    return out.text;
  };
  const request: ParsedRequest = {
    ...r,
    url: sub(r.url),
    headers: r.headers.map((h) => (h.enabled ? { ...h, name: sub(h.name), value: sub(h.value) } : { ...h })),
    body: sub(r.body),
  };
  return { request, nulls: [...nulls], missing: [...missing] };
}
