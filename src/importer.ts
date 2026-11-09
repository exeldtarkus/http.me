// menulis hasil import ke disk (tanpa vscode): per batch, progress, konflik, cancel, undo, ringkasan hasil, laporan
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { serialQueue } from './runner';
import type { ImportPlan } from './importCommon';

export type Conflict = 'skip' | 'overwrite' | 'keep';
export type ApplyOptions = {
  /** folder tujuan (absolut) */ dir: string;
  /** path rencana yang dicentang (default semua) */ selected?: ReadonlySet<string>;
  conflicts?: ReadonlyMap<string, Conflict>;
  signal?: AbortSignal;
  onProgress?(done: number, total: number, path: string): void;
  /** file per batch sebelum memberi jalan event loop (default 5) */ batch?: number;
};
export type ApplyResult = {
  dir: string; total: number; cancelled: boolean;
  created: { path: string; hash: string }[]; overwritten: { path: string; previous: string; hash: string }[];
  skipped: string[]; failed: { path: string; error: string }[];
};

/** antrean import sendiri (bukan 6 slot request): import kedua menunggu yang pertama */
export const importQueue = serialQueue();

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const exists = (p: string) => fs.stat(p).then(() => true, () => false); // stat gagal = belum ada
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

function target(dir: string, path: string): string {
  const abs = resolve(dir, path);
  const rel = relative(dir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path is outside the target folder: ${path}`);
  return abs;
}

/** path rencana yang sudah ada di folder tujuan */
export async function conflictsOf(plan: ImportPlan, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of plan.files) if (!/^\.\.|^[\\/]/.test(f.path) && await exists(join(dir, f.path))) out.push(f.path);
  return out;
}

async function freeName(abs: string): Promise<string> {
  const m = /^(.*?)(\.[^./\\]+)?$/.exec(abs)!;
  for (let n = 2; ; n++) { const p = `${m[1]} ${n}${m[2] ?? ''}`; if (!(await exists(p))) return p; }
}

export async function applyPlan(plan: ImportPlan, o: ApplyOptions): Promise<ApplyResult> {
  const files = plan.files.filter((f) => !o.selected || o.selected.has(f.path));
  const res: ApplyResult = { dir: o.dir, total: files.length, cancelled: false, created: [], overwritten: [], skipped: [], failed: [] };
  const batch = o.batch ?? 5;
  let done = 0;
  for (const f of files) {
    if (o.signal?.aborted) { res.cancelled = true; break; }
    try {
      let abs = target(o.dir, f.path);
      if (await exists(abs)) {
        const c = o.conflicts?.get(f.path) ?? 'skip';
        if (c === 'skip') { res.skipped.push(f.path); done++; continue; }
        if (c === 'overwrite') {
          const previous = await fs.readFile(abs, 'utf8');
          await fs.writeFile(abs, f.content);
          res.overwritten.push({ path: f.path, previous, hash: sha(f.content) });
          done++;
          o.onProgress?.(done, files.length, f.path);
          if (done % batch === 0) await yieldLoop();
          continue;
        }
        abs = await freeName(abs);
      }
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.content, { flag: 'wx' });
      res.created.push({ path: abs, hash: sha(f.content) });
    } catch (e) {
      // tidak dilempar: kegagalan per file dicatat di result.failed; pemanggil mencatat log ERROR + stack, import file lain jalan
      res.failed.push({ path: f.path, error: e instanceof Error ? e.message : String(e) });
    }
    done++;
    o.onProgress?.(done, files.length, f.path);
    if (done % batch === 0) await yieldLoop();
  }
  if (o.signal?.aborted && done < files.length) res.cancelled = true;
  return res;
}

/** hapus file yang dibuat import (yang sudah diubah user dibiarkan), kembalikan overwrite; folder yang jadi kosong dihapus */
export async function undoImport(r: ApplyResult): Promise<{ removed: number; restored: number; kept: string[] }> {
  let removed = 0, restored = 0;
  const kept: string[] = [];
  const dirs = new Set<string>();
  for (const c of r.created) {
    const now = await fs.readFile(c.path, 'utf8').catch(() => undefined); // sudah hilang: tidak ada yang dihapus
    if (now === undefined) continue;
    if (sha(now) !== c.hash) { kept.push(c.path); continue; }
    await fs.rm(c.path);
    removed++;
    dirs.add(dirname(c.path));
  }
  for (const o of r.overwritten) {
    const abs = join(r.dir, o.path);
    const now = await fs.readFile(abs, 'utf8').catch(() => undefined); // sudah hilang / tak terbaca: tidak dikembalikan
    if (now !== undefined && sha(now) === o.hash) { await fs.writeFile(abs, o.previous); restored++; } else kept.push(abs);
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    for (let cur = d; cur.startsWith(r.dir) && cur !== r.dir; cur = dirname(cur)) {
      if ((await fs.readdir(cur).catch(() => ['x'])).length) break; // tak terbaca = anggap tidak kosong, jangan hapus
      await fs.rmdir(cur);
    }
  }
  return { removed, restored, kept };
}

export type Summary = { kind: 'success' | 'partial' | 'failed' | 'cancelled'; message: string; detail: string; actions: string[] };
const isRequest = (p: string) => /\.http$/i.test(p) && !/(^|[\\/])_[^\\/]*$/.test(p);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** teks popup hasil (berhasil / sebagian gagal / gagal total / dibatalkan) */
export function summarize(r: ApplyResult, name: string): Summary {
  const ok = r.created.length + r.overwritten.length;
  if (r.cancelled) return { kind: 'cancelled', message: 'Import cancelled', detail: `${r.created.length} of ${r.total} files were created`, actions: ['Remove created files', 'Keep'] };
  if (r.failed.length && ok === 0) return { kind: 'failed', message: 'Import failed', detail: r.failed.map((f) => `${f.path} — ${f.error}`).join('\n'), actions: ['Show log'] };
  const reqs = [...r.created.map((c) => c.path), ...r.overwritten.map((o) => o.path)].filter(isRequest).length;
  const totalReqs = reqs + r.failed.filter((f) => isRequest(f.path)).length;
  if (r.failed.length) return { kind: 'partial', message: `Imported ${reqs} of ${totalReqs} requests`, detail: r.failed.map((f) => `${f.path} — ${f.error}`).join('\n'), actions: ['Retry failed', 'Show log'] };
  return { kind: 'success', message: `Imported ${plural(reqs, 'request')}`, detail: `${name} → ${relative('/', r.dir) || '.'} as .http files${r.skipped.length ? ` (${r.skipped.length} skipped)` : ''}`, actions: ['Show in Collections', 'Show report'] };
}

/** laporan Markdown untuk output channel */
export function reportMarkdown(plan: ImportPlan, r: ApplyResult): string {
  const lines = [`# Import report: ${plan.name}`, '', `- Source format: ${plan.format}`, `- Target folder: ${r.dir}`, `- Created: ${r.created.length}, overwritten: ${r.overwritten.length}, skipped: ${r.skipped.length}, failed: ${r.failed.length}${r.cancelled ? ' (cancelled)' : ''}`];
  if (plan.warnings.length) lines.push('', '## Warnings', ...plan.warnings.map((w) => `- ${w}`));
  if (r.failed.length) lines.push('', '## Failed', ...r.failed.map((f) => `- ${f.path} — ${f.error}`));
  return `${lines.join('\n')}\n`;
}
