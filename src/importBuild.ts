// membangun rencana import (deteksi + parse + generate) di worker thread supaya event loop extension host tidak terblokir
// (request yang sedang berjalan tetap diproses); buildPlan murni dan dipakai worker (tanpa vscode)
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectFormat, parseDoc, type FormatName, type ImportFile, type ImportPlan } from './importCommon';
import { importOpenApi } from './openapi';
import { importPostman } from './postman';
import { parseRequest } from './httpFile';

export type BuildJob = { text: string; /** folder file spec: `$ref` relatif dibaca dari sini */ baseDir?: string; envs: { name: string; values: [string, string | null][] }[] };
export type BuildResult = { format?: FormatName; plan?: ImportPlan; error?: string; stack?: string };

/** method + judul + jenis untuk baris preview */
export function describe(f: Pick<ImportFile, 'path' | 'content'>): NonNullable<ImportFile['info']> {
  const base = f.path.split('/').pop() ?? '';
  if (/\.http$/i.test(base) && !base.startsWith('_')) { const r = parseRequest(f.content); return { method: r.method, ...(r.title ? { title: r.title } : {}), kind: 'request' }; }
  if (base === '_auth.http') return { kind: 'auth' };
  if (/\.js$/i.test(base)) return { kind: 'script' };
  if (base === '_variables.json') return { kind: 'variables' };
  return { kind: 'file' };
}

/** format dikenali; Postman / OpenAPI langsung jadi plan, format lain (cURL, Environment) hanya format-nya */
export function buildPlan(job: BuildJob): BuildResult {
  try {
    const d = detectFormat(job.text);
    if (d.format !== 'postman-collection' && d.format !== 'openapi' && d.format !== 'swagger') return { format: d.format };
    const plan = d.format === 'postman-collection' ? importPostman(d.data) : importOpenApi(d.data, {
      envs: job.envs.map((e) => ({ name: e.name, values: new Map(e.values) })),
      loadFile: (rel) => {
        if (!job.baseDir) throw new Error(`external $ref "${rel}" needs a spec imported from a file`);
        return parseDoc(readFileSync(join(job.baseDir, rel), 'utf8'));
      },
    });
    for (const f of plan.files) f.info = describe(f);
    return { format: d.format, plan };
  } catch (e) {
    // dikembalikan sebagai hasil (pesan + stack): pemanggil di extension host mencatat log ERROR dan menampilkan pesan
    return { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined };
  }
}

/** jalankan buildPlan di worker; signal abort = worker dihentikan. Error dilempar dengan pesan asli (stack di `cause`) */
export function runInWorker(job: BuildJob, signal?: AbortSignal): Promise<BuildResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Import cancelled'));
    const worker = new Worker(join(dirname(__filename), 'importWorker.js'), { workerData: job });
    let done = false;
    const end = (fn: () => void) => { if (done) return; done = true; signal?.removeEventListener('abort', onAbort); void worker.terminate(); fn(); };
    const onAbort = () => end(() => reject(new Error('Import cancelled')));
    signal?.addEventListener('abort', onAbort);
    worker.once('message', (r: BuildResult) => end(() => (r.error ? reject(new Error(r.error, { cause: r.stack })) : resolve(r))));
    worker.once('error', (e) => end(() => reject(e)));
    worker.once('exit', (code) => end(() => reject(new Error(`Import worker stopped unexpectedly (exit ${code})`))));
  });
}
