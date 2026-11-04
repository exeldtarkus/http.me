// paste cURL: nilai yang sama dengan nilai Environment / Globals jadi {{VARIABLE}} (tanpa vscode)
import type { ParsedRequest } from './httpFile';
import type { VarValue } from './vars';

/** env undefined = Globals */
export type Candidate = { name: string; value: string; env?: string };
export type Replacement = { name: string; env?: string; where: string };

const MIN_LENGTH = 4;

/** urutan: Environment aktif → Environment lain → Globals, di tiap kelompok nilai terpanjang dulu; nilai ganda = yang pertama */
export function varizeCandidates(active: string | undefined, envs: readonly { name: string; values: ReadonlyMap<string, VarValue> }[], globals: ReadonlyMap<string, VarValue>): Candidate[] {
  const groups = [...envs.filter((e) => e.name === active), ...envs.filter((e) => e.name !== active)].map((e) => ({ env: e.name as string | undefined, values: e.values }));
  groups.push({ env: undefined, values: globals });
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const g of groups) {
    const list = [...g.values].filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length >= MIN_LENGTH && !e[1].includes('{{'))
      .sort((a, b) => b[1].length - a[1].length);
    for (const [name, value] of list) {
      if (seen.has(value)) continue;
      seen.add(value);
      out.push({ name, value, ...(g.env !== undefined ? { env: g.env } : {}) });
    }
  }
  return out;
}

const decode = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } }; // %xx rusak: dibandingkan apa adanya

export function varize(r: ParsedRequest, candidates: readonly Candidate[]): { request: ParsedRequest; replaced: Replacement[] } {
  const replaced: Replacement[] = [];
  const note = (c: Candidate, where: string) => {
    if (!replaced.some((x) => x.name === c.name && x.env === c.env)) replaced.push({ name: c.name, ...(c.env !== undefined ? { env: c.env } : {}), where });
  };
  /** nilai persis (setelah decode) → {{NAME}} */
  const exact = (raw: string, where: string, dec = (s: string) => s): string => {
    if (raw.length < MIN_LENGTH || raw.includes('{{')) return raw;
    const c = candidates.find((x) => x.value === dec(raw));
    if (!c) return raw;
    note(c, where);
    return `{{${c.name}}}`;
  };

  // URL: prefix terpanjang di batas / ? # (atau akhir), lalu nilai query param
  let url = r.url;
  if (!url.startsWith('{{')) {
    const hit = candidates.filter((c) => url.startsWith(c.value) && (c.value.endsWith('/') || url.length === c.value.length || '/?#'.includes(url[c.value.length])))
      .reduce<Candidate | undefined>((best, c) => (!best || c.value.length > best.value.length ? c : best), undefined);
    if (hit) { note(hit, 'URL'); url = `{{${hit.name}}}${url.slice(hit.value.length)}`; }
  }
  url = url.replace(/([?&][^=&#]*=)([^&#]*)/g, (_m, k: string, v: string) => k + exact(v, 'query', decode));

  const headers = r.headers.map((h) => {
    const name = h.name.toLowerCase();
    let value: string;
    if (name === 'authorization' || name === 'proxy-authorization') {
      const m = /^(\w+)(\s+)(.+)$/.exec(h.value);
      value = exact(h.value, h.name);
      if (value === h.value && m) value = `${m[1]}${m[2]}${exact(m[3], h.name)}`;
    } else if (name === 'cookie') {
      value = h.value.replace(/(^|;\s*)([^=;]+=)([^;]*)/g, (_m, sep: string, k: string, v: string) => sep + k + exact(v, 'cookie'));
    } else value = exact(h.value, h.name);
    return { ...h, value };
  });

  let body = r.body;
  if (r.bodyType === 'json') {
    // literal string JSON yang bukan key (tidak diikuti ':'), format body tetap
    body = body.replace(/"((?:[^"\\]|\\.)*)"(\s*:)?/g, (m, inner: string, colon?: string) => {
      if (colon) return m;
      let value: string;
      try { value = JSON.parse(m); } catch { return m; } // literal aneh: dibiarkan
      const out = exact(value, 'body');
      return out === value ? m : `"${out}"`;
    });
  } else if (r.bodyType === 'form') {
    body = body.replace(/(^|&)([^=&]*=)([^&]*)/g, (_m, sep: string, k: string, v: string) => sep + k + exact(v, 'body', decode));
  }
  return { request: { ...r, url, headers, body }, replaced };
}
