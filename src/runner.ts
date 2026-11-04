// antrean request (tanpa vscode): jalan async paralel, maks 6 bersamaan, sisanya antre; AbortController per job
import { RequestError } from './http';

export type JobState = 'queued' | 'running';
export type Job = { id: number; key: string; label: string; state: JobState; startedAt?: number; controller: AbortController };
type Entry = Job & { start: () => void; reject: (e: unknown) => void };

export function createRunner(opts: { limit?: number; onChange?: () => void; now?: () => number } = {}) {
  const limit = opts.limit ?? 6;
  const now = opts.now ?? Date.now;
  const entries: Entry[] = [];
  let nextId = 1;
  const changed = () => opts.onChange?.();

  /** job antre: dibuang + ditolak 'Cancelled'; job berjalan: AbortController memutus task */
  function cancelEntry(e: Entry): void {
    if (e.state === 'running') return e.controller.abort();
    entries.splice(entries.indexOf(e), 1);
    e.reject(new RequestError('Cancelled', 'cancelled'));
  }

  function pump(): void {
    for (const e of entries) {
      if (entries.filter((x) => x.state === 'running').length >= limit) return;
      if (e.state === 'queued') e.start();
    }
  }

  return {
    limit,
    /** jalankan task; job lain tidak menunggu job ini (kecuali batas `limit` penuh). Key sama (Send lagi di file yang sama) = job lama dibatalkan */
    run<T>(key: string, label: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      for (const old of entries.filter((x) => x.key === key && !x.controller.signal.aborted)) cancelEntry(old);
      return new Promise<T>((resolve, reject) => {
        const e: Entry = {
          id: nextId++, key, label, state: 'queued', controller: new AbortController(), reject,
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
    /** Cancel Request (tab / file): job milik key, berjalan maupun antre; false = tidak ada */
    cancel(key: string): boolean {
      const hit = entries.filter((e) => e.key === key);
      hit.forEach(cancelEntry);
      if (hit.length) changed();
      return hit.length > 0;
    },
    /** ✕ per request di Quick Pick */
    cancelJob(id: number): boolean {
      const e = entries.find((x) => x.id === id);
      if (e) { cancelEntry(e); changed(); }
      return !!e;
    },
    /** Cancel All Requests: jumlah job yang dibatalkan */
    cancelAll(): number {
      const all = [...entries];
      all.forEach(cancelEntry);
      if (all.length) changed();
      return all.length;
    },
    /** job berjalan + antre, urut waktu Send */
    jobs: (): Job[] => entries.map(({ start: _s, reject: _r, ...j }) => j),
    /** posisi antrean job milik key: n dari m (undefined = sedang jalan / tidak ada) */
    queuePosition(key: string): { n: number; m: number } | undefined {
      const queued = entries.filter((e) => e.state === 'queued');
      const n = queued.findIndex((e) => e.key === key);
      return n < 0 ? undefined : { n: n + 1, m: queued.length };
    },
  };
}

export type Runner = ReturnType<typeof createRunner>;

/**
 * satu tahap rantai request (pre-script, request, post-script, auto login): ditolak 'Cancelled' begitu signal batal,
 * tanpa menunggu tahap selesai; tahap berikutnya tidak dimulai bila signal sudah batal
 */
export function step<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new RequestError('Cancelled', 'cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RequestError('Cancelled', 'cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    fn().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * antrean tulis per key (Environment): cookie jar & current value ditulis bergiliran supaya request paralel
 * tidak saling menimpa; key berbeda tetap jalan bersamaan
 */
export function serialQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined); // ekor antrean tidak ikut gagal: error tetap sampai ke pemanggil yang mencatat log
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  };
}
