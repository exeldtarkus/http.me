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
