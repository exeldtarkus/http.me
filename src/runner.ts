// antrean request (tanpa vscode): jalan async paralel, maks 6 bersamaan, sisanya antre; AbortController per job
export type JobState = 'queued' | 'running';
export type Job = { id: number; key: string; label: string; state: JobState; startedAt?: number; controller: AbortController };
type Entry = Job & { start: () => void };

export function createRunner(opts: { limit?: number; onChange?: () => void; now?: () => number } = {}) {
  const limit = opts.limit ?? 6;
  const now = opts.now ?? Date.now;
  const entries: Entry[] = [];
  let nextId = 1;
  const changed = () => opts.onChange?.();

  function pump(): void {
    for (const e of entries) {
      if (entries.filter((x) => x.state === 'running').length >= limit) return;
      if (e.state === 'queued') e.start();
    }
  }

  return {
    limit,
    /** jalankan task; job lain tidak menunggu job ini (kecuali batas `limit` penuh) */
    run<T>(key: string, label: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const e: Entry = {
          id: nextId++, key, label, state: 'queued', controller: new AbortController(),
          start: () => {
            e.state = 'running';
            e.startedAt = now();
            // job dibuang dari daftar sebelum pemanggil menerima hasil
            const done = () => { entries.splice(entries.indexOf(e), 1); pump(); changed(); };
            task(e.controller.signal).then((v) => { done(); resolve(v); }, (err: unknown) => { done(); reject(err); });
          },
        };
        entries.push(e);
        pump();
        changed();
      });
    },
    /** job berjalan + antre, urut waktu Send */
    jobs: (): Job[] => entries.map(({ start: _s, ...j }) => j),
    /** posisi antrean job milik key: n dari m (undefined = sedang jalan / tidak ada) */
    queuePosition(key: string): { n: number; m: number } | undefined {
      const queued = entries.filter((e) => e.state === 'queued');
      const n = queued.findIndex((e) => e.key === key);
      return n < 0 ? undefined : { n: n + 1, m: queued.length };
    },
  };
}

export type Runner = ReturnType<typeof createRunner>;
