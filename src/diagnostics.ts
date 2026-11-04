// {{variable}} di .http / script / JSON Environment (tanpa vscode): token, status, pesan diagnostics, hover, references.
// Satu pencari token (findVarTokens) dipakai Diagnostics, Hover, Definition, References, dan panel webview.
import { DYNAMIC_NAMES, dynamicValue, type VarValue } from './vars';

export type VarToken = { name: string; args?: string; start: number; end: number; kind: 'var' | 'dynamic' | 'script' };
export type VarContext = {
  active?: string;
  environments: { name: string; values: ReadonlyMap<string, VarValue>; secret: ReadonlySet<string> }[];
  globals: ReadonlyMap<string, VarValue>;
  globalSecret?: ReadonlySet<string>;
  /** nama yang di-set script (httpme.vars) */ script?: ReadonlySet<string>;
};
export type Position = { line: number; character: number };
export type Diag = { name: string; start: number; end: number; range: { start: Position; end: Position }; message: string; kind: 'null' | 'missing' };

const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const SCRIPT = /httpme\.(?:environment|globals|vars)\.(?:get|set|unset|has)\(\s*(['"`])([^'"`\n]+)\1/g;

/** semua token berurutan posisi; script = juga httpme.environment.get/set('name') (range = nama di dalam kutip) */
export function findVarTokens(text: string, script = false): VarToken[] {
  const out: VarToken[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[1];
    if (!raw) continue;
    const [name, ...args] = raw.split(/\s+/);
    out.push({ name, ...(args.length ? { args: args.join(' ') } : {}), start: m.index!, end: m.index! + m[0].length, kind: name.startsWith('$') ? 'dynamic' : 'var' });
  }
  if (script) {
    for (const m of text.matchAll(SCRIPT)) {
      const start = m.index! + m[0].length - 1 - m[2].length;
      out.push({ name: m[2], start, end: start + m[2].length, kind: 'script' });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** variabel file `@name = value` */
export function fileVariables(text: string): Map<string, string> {
  return new Map([...text.matchAll(/^[ \t]*@([\w.-]+)[ \t]*=[ \t]*(.*?)[ \t]*$/gm)].map((m) => [m[1], m[2]]));
}

const SAMPLE = { now: () => 0, random: () => 0, uuid: () => '' };
export type VarStatus = { kind: 'ok' | 'dynamic' } | { kind: 'null' | 'missing'; message: string };

/** status satu nama (warna token + pesan diagnostics) */
export function varStatus(name: string, ctx: VarContext, file: ReadonlyMap<string, string> = new Map()): VarStatus {
  if (name.startsWith('$')) {
    return DYNAMIC_NAMES.includes(name) ? { kind: 'dynamic' } : { kind: 'missing', message: `Unknown dynamic variable "${name}"` };
  }
  if (ctx.script?.has(name) || file.has(name)) return { kind: 'ok' };
  const active = ctx.environments.find((e) => e.name === ctx.active);
  const inActive = active?.values.get(name);
  if (typeof inActive === 'string') return { kind: 'ok' };
  if (typeof ctx.globals.get(name) === 'string') return { kind: 'ok' };
  if (active && inActive === null) {
    const others = ctx.environments.filter((e) => e !== active && e.values.get(name) === null).map((e) => e.name);
    return { kind: 'null', message: `${name} is NULL in Environment "${active.name}"${others.length ? ` (also NULL in: ${others.join(', ')})` : ''}` };
  }
  if (ctx.globals.has(name)) return { kind: 'null', message: `${name} is NULL in Globals` };
  const defined = ctx.environments.filter((e) => e.values.has(name)).map((e) => e.name);
  if (!active && defined.length) return { kind: 'missing', message: `Variable "${name}" needs an active Environment (defined in: ${defined.join(', ')})` };
  return { kind: 'missing', message: `Variable "${name}" not found` };
}

export function positionAt(text: string, offset: number): Position {
  let line = 0;
  let start = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; start = i + 1; }
  }
  return { line, character: offset - start };
}

const diag = (text: string, name: string, start: number, end: number, message: string, kind: Diag['kind']): Diag =>
  ({ name, start, end, range: { start: positionAt(text, start), end: positionAt(text, end) }, message, kind });

/** {{var}} yang NULL di Environment aktif / tidak ditemukan / variable dinamis tidak dikenal */
export function diagnoseHttp(text: string, ctx: VarContext, script = false): Diag[] {
  const file = script ? new Map<string, string>() : fileVariables(text);
  const out: Diag[] = [];
  for (const t of findVarTokens(text, script)) {
    if (t.kind === 'script') continue; // set() / get() di script tidak wajib sudah ada
    const s = varStatus(t.name, ctx, file);
    if (s.kind === 'null' || s.kind === 'missing') out.push(diag(text, t.name, t.start, t.end, s.message, s.kind));
  }
  return out;
}

/** nama variable yang tidak ketemu sama sekali (bukan NULL) */
export const missingVariables = (text: string, ctx: VarContext): string[] =>
  [...new Set(diagnoseHttp(text, ctx).filter((d) => d.kind === 'missing').map((d) => d.name))];

// objek variable di file Environment selalu datar (tanpa objek bersarang)
const OBJECT = /\{[^{}]*\}/g;
const KEY = /"key"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/** `"value": null` di file .httpme/environments/<nama>.json */
export function diagnoseEnvironmentJson(text: string, envName: string): Diag[] {
  const out: Diag[] = [];
  for (const m of text.matchAll(OBJECT)) {
    const key = KEY.exec(m[0]);
    const val = /"value"\s*:\s*(null)\b/.exec(m[0]);
    if (!key || !val) continue;
    const start = m.index! + val.index + val[0].length - 4;
    const name = JSON.parse(`"${key[1]}"`) as string;
    out.push(diag(text, name, start, start + 4, `${name} has no value (NULL) in Environment "${envName}"`, 'null'));
  }
  return out;
}

/** posisi nama key (di dalam kutip) untuk Definition / Peek */
export function findKeyInJson(text: string, key: string): { start: number; end: number } | undefined {
  for (const m of text.matchAll(OBJECT)) {
    const k = KEY.exec(m[0]);
    if (!k || JSON.parse(`"${k[1]}"`) !== key) continue;
    const start = m.index! + k.index + k[0].length - 1 - k[1].length;
    return { start, end: start + k[1].length };
  }
  return undefined;
}

// ---------- hover ----------
export type HoverInfo = {
  name: string;
  status: VarStatus;
  example?: string;
  script?: boolean;
  file?: string;
  /** value undefined = key tidak ada di Environment itu */
  environments: { name: string; value: VarValue | undefined; secret: boolean; active: boolean }[];
  globals?: { value: VarValue; secret: boolean };
};

export function hoverInfo(name: string, ctx: VarContext, file: ReadonlyMap<string, string> = new Map()): HoverInfo {
  const status = varStatus(name, ctx, file);
  if (name.startsWith('$')) return { name, status, environments: [], ...(status.kind === 'dynamic' ? { example: dynamicValue(name) } : {}) };
  return {
    name, status,
    ...(ctx.script?.has(name) ? { script: true } : {}),
    ...(file.has(name) ? { file: file.get(name) } : {}),
    environments: ctx.environments.map((e) => ({ name: e.name, value: e.values.get(name), secret: e.secret.has(name), active: e.name === ctx.active })),
    ...(ctx.globals.has(name) ? { globals: { value: ctx.globals.get(name)!, secret: !!ctx.globalSecret?.has(name) } } : {}),
  };
}

const cmd = (id: string, args: unknown[]) => `command:${id}?${encodeURIComponent(JSON.stringify(args))}`;
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** Markdown hover (HoverProvider); panel webview menggambar HoverInfo yang sama sendiri */
export function hoverMarkdown(info: HoverInfo): string {
  if (info.name.startsWith('$')) {
    return info.status.kind === 'dynamic' ? `Dynamic variable, generated at send time. Example: ${code(info.example ?? '')}` : `$(error) ${(info.status as { message: string }).message}`;
  }
  const lines: string[] = [];
  if (info.status.kind === 'null' || info.status.kind === 'missing') lines.push(`$(error) ${info.status.message}`, '');
  if (info.script) lines.push('Set by a script');
  if (info.file !== undefined) lines.push(`File variable: ${code(info.file)}`);
  for (const e of info.environments) {
    if (e.value === undefined) continue;
    const label = e.active ? `**${e.name}** (active)` : e.name;
    const value = e.value === null ? '_NULL_' : e.secret ? `${code('••••')} [Show](${cmd('httpme.showSecret', [e.name, info.name])})` : code(e.value);
    lines.push(`${label}: ${value}`);
  }
  if (info.globals) {
    const g = info.globals;
    lines.push(`Globals: ${g.value === null ? '_NULL_' : g.secret ? `${code('••••')} [Show](${cmd('httpme.showSecret', ['', info.name])})` : code(g.value)}`);
  }
  const active = info.environments.find((e) => e.active);
  if (active) lines.push('', `[Open in Environment "${active.name}"](${cmd('httpme.gotoVariable', [info.name])})`);
  return lines.join('  \n');
}

// ---------- references & completion ----------
export function findReferences(files: readonly { path: string; text: string }[], name: string): { path: string; start: number; end: number }[] {
  return files.flatMap((f) => findVarTokens(f.text, /\.js$/i.test(f.path)).filter((t) => t.name === name).map((t) => ({ path: f.path, start: t.start, end: t.end })));
}

/** autocomplete {{ : Environment aktif + Globals + variabel file, lalu variable dinamis */
export function completionNames(ctx: VarContext, file: ReadonlyMap<string, string> = new Map()): string[] {
  const active = ctx.environments.find((e) => e.name === ctx.active);
  const names = new Set([...(active?.values.keys() ?? []), ...ctx.globals.keys(), ...file.keys(), ...(ctx.script ?? [])]);
  return [...[...names].sort((a, b) => a.localeCompare(b)), ...DYNAMIC_NAMES];
}
