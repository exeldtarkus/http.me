// body besar dari disk (tanpa vscode): `< ./file` dan multipart/form-data dengan bagian file di-stream, tidak dibaca penuh ke memory
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { BodyStream } from './http';

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (e) {
    throw new Error(`File not found: ${path}`, { cause: e });
  }
}

/** body dari satu file di disk */
export async function fileBody(path: string): Promise<BodyStream> {
  return { length: await fileSize(path), stream: () => createReadStream(path) };
}

type Segment = { buf: Buffer } | { path: string; size: number };

/**
 * body multipart `.http`: bagian dipisah `--boundary`, baris `< ./path` sebagai isi bagian = file dari disk.
 * Teks diubah ke CRLF (kawat HTTP); Content-Length dihitung dari ukuran file sehingga tidak perlu chunked.
 */
export async function multipartBody(text: string, contentType: string, resolvePath: (path: string) => string): Promise<BodyStream> {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!boundary) throw new Error('multipart/form-data needs a boundary in the Content-Type header');
  const b = boundary[1] ?? boundary[2];
  const segs: Segment[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = lines.findIndex((l) => l === `--${b}`);
  if (i < 0) throw new Error(`multipart body has no --${b} part`);
  for (; i < lines.length && lines[i] !== `--${b}--`; ) {
    i++; // baris --boundary
    const head: string[] = [];
    while (i < lines.length && lines[i] !== '') head.push(lines[i++]);
    i++; // baris kosong pemisah header / isi
    const content: string[] = [];
    while (i < lines.length && lines[i] !== `--${b}` && lines[i] !== `--${b}--`) content.push(lines[i++]);
    segs.push({ buf: Buffer.from(`--${b}\r\n${head.join('\r\n')}\r\n\r\n`) });
    const file = content.length === 1 ? /^<\s+(.+)$/.exec(content[0]) : null;
    if (file) { const path = resolvePath(file[1].trim()); segs.push({ path, size: await fileSize(path) }); } else segs.push({ buf: Buffer.from(content.join('\r\n')) });
    segs.push({ buf: Buffer.from('\r\n') });
  }
  segs.push({ buf: Buffer.from(`--${b}--\r\n`) });
  const length = segs.reduce((n, s) => n + ('buf' in s ? s.buf.length : s.size), 0);
  return { length, stream: () => (async function* () { for (const s of segs) { if ('buf' in s) yield s.buf; else yield* createReadStream(s.path); } })() };
}
