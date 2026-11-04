// teks status bar request berjalan + item Quick Pick Cancel (tanpa vscode, pola moonage runningStatus.ts)
import type { Job } from './runner';

const duration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/** `⟳ 2 requests running · 5s · 1 queued` (durasi = request tertua); tidak ada job = undefined (status bar disembunyikan) */
export function runningText(jobs: Job[], now: number): string | undefined {
  const running = jobs.filter((j) => j.state === 'running');
  const queued = jobs.length - running.length;
  if (!jobs.length) return undefined;
  const oldest = Math.min(...running.map((j) => j.startedAt ?? now), now);
  const head = running.length ? `${running.length} request${running.length === 1 ? '' : 's'} running · ${duration(now - oldest)}` : 'requests waiting';
  return `$(sync~spin) ${head}${queued ? ` · ${queued} queued` : ''}`;
}

/** item Quick Pick (tombol ✕ ditambahkan glue VS Code) */
export function runningItems(jobs: Job[], now: number): { id: number; label: string; description: string }[] {
  const queued = jobs.filter((j) => j.state === 'queued');
  return jobs.map((j) => j.state === 'running'
    ? { id: j.id, label: `$(sync~spin) ${j.label}`, description: `running · ${duration(now - (j.startedAt ?? now))}` }
    : { id: j.id, label: `$(clock) ${j.label}`, description: `Queued ${queued.indexOf(j) + 1}/${queued.length}` });
}

/** `METHOD /path`: origin atau {{baseUrl}} di depan dibuang, query tetap */
export function shortPath(url: string): string {
  const v = /^\{\{[^}]+\}\}(.*)$/.exec(url.trim());
  if (v) return v[1] || '/';
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url; // bukan URL lengkap: tampil apa adanya
  }
}
const labelPath = (label: string) => { const i = label.indexOf(' '); return i < 0 ? label : `${label.slice(0, i)} ${shortPath(label.slice(i + 1))}`; };

/** tooltip status bar: satu baris per request */
export function runningTooltip(jobs: Job[], now: number): string {
  return jobs.map((j) => `${labelPath(j.label)}${j.env ? ` — ${j.env}` : ''} · ${j.state === 'running' ? duration(now - (j.startedAt ?? now)) : 'queued'}`).join('\n');
}

export function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** ringkasan satu entri History (isi lengkap di history.ts) */
export type HistorySummary = { id: string; time: number; method: string; url: string; env?: string; status?: number; ms?: number; error?: string; cancelled?: boolean; file?: string };

/** item Quick Pick History (terbaru di atas sudah diurutkan pemanggil) */
export function historyItems(entries: HistorySummary[], now: number): { id: string; label: string; description: string; detail: string | undefined }[] {
  return entries.map((e) => {
    const icon = e.cancelled ? '$(circle-slash)' : e.error || (e.status ?? 0) >= 400 ? '$(error)' : '$(pass)';
    const head = e.cancelled ? 'Cancelled' : e.error ? 'Error' : String(e.status);
    const parts = [head, e.env, ago(now - e.time), e.ms !== undefined && !e.error && !e.cancelled ? `${e.ms} ms` : undefined].filter(Boolean);
    return { id: e.id, label: `${icon} ${e.method} ${shortPath(e.url)}`, description: parts.join(' · '), detail: e.error ?? (e.file ? decodeURIComponent(e.file.split('/').pop() ?? '') : undefined) };
  });
}
