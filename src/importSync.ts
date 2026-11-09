// sinkron ulang hasil import OpenAPI: cocokkan lewat `# @operation`, merge tanpa menghapus edit user (tanpa vscode)
import { parseRequest, serializeRequest, type Header } from './httpFile';
import { parseFormatted, stringifyFormatted } from './format';
import type { ImportPlan } from './importCommon';

export const SOURCE_FILE = '_source.json';
export type Source = { type: 'file' | 'url' | 'clipboard'; /** path file atau URL (boleh {{var}}) */ location: string; format: string };

export const sourceFile = (s: Source): string => stringifyFormatted(s);
export function parseSource(text: string): Source {
  const j = parseFormatted<Partial<Source>>(text, SOURCE_FILE);
  if (typeof j.location !== 'string' || typeof j.type !== 'string' || typeof j.format !== 'string') throw new Error(`${SOURCE_FILE}: expected "type", "location" and "format"`);
  return { type: j.type as Source['type'], location: j.location, format: j.format };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Update: isi dari spec baru; script, flag (# @no-redirect …), status aktif header, header & # @disabled tambahan milik user dipertahankan */
export function mergeRequest(existing: string, incoming: string): string {
  const mine = parseRequest(existing);
  const next = parseRequest(incoming);
  const headers: Header[] = next.headers.map((h) => {
    const m = mine.headers.find((x) => same(x.name, h.name));
    return m ? { ...h, enabled: m.enabled } : h;
  });
  for (const m of mine.headers) if (!headers.some((h) => same(h.name, m.name))) headers.push(m);
  const disabledParams = [...next.disabledParams, ...mine.disabledParams.filter((p) => !next.disabledParams.some((n) => n.key === p.key))];
  return serializeRequest({
    ...next, headers, disabledParams,
    preScripts: mine.preScripts, postScripts: mine.postScripts,
    followRedirects: mine.followRedirects, insecure: mine.insecure, timeoutSec: mine.timeoutSec,
    noCookieJar: mine.noCookieJar, noSendCookies: mine.noSendCookies, noSaveCookies: mine.noSaveCookies,
    login: mine.login, noScripts: mine.noScripts, noPre: mine.noPre, noPost: mine.noPost,
    vars: mine.vars, auth: next.auth ?? mine.auth,
  });
}

const REMOVED = '# Removed in spec';
export function markRemoved(content: string): string {
  const r = parseRequest(content);
  if (r.preamble.includes(REMOVED)) return content;
  return serializeRequest({ ...r, preamble: [REMOVED, ...r.preamble] });
}

export type SyncItem = { kind: 'new' | 'unchanged' | 'update' | 'removed'; path: string; operation?: string; /** isi yang ditulis (update: hasil merge, new: dari spec, removed: ditandai) */ merged?: string; existing?: string };

/** existing = file .http di folder collection; hanya yang punya `# @operation` ikut dicocokkan */
export function planResync(existing: readonly { path: string; content: string }[], plan: ImportPlan): SyncItem[] {
  const byOp = new Map<string, { path: string; content: string }>();
  for (const e of existing) { const op = parseRequest(e.content).operation; if (op) byOp.set(op, e); }
  const out: SyncItem[] = [];
  const seen = new Set<string>();
  for (const f of plan.files) {
    if (!f.operation) continue;
    const hit = byOp.get(f.operation);
    seen.add(f.operation);
    if (!hit) { out.push({ kind: 'new', path: f.path, operation: f.operation, merged: f.content }); continue; }
    const merged = mergeRequest(hit.content, f.content);
    out.push({ kind: merged === hit.content ? 'unchanged' : 'update', path: hit.path, operation: f.operation, merged, existing: hit.content });
  }
  for (const [op, e] of byOp) if (!seen.has(op)) out.push({ kind: 'removed', path: e.path, operation: op, merged: markRemoved(e.content), existing: e.content });
  return out;
}
