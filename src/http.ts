// kirim request HTTP (tanpa vscode). Pakai node:http/https, bukan fetch: fetch Node tidak bisa "abaikan SSL" per request
// tanpa undici, dan redirect perlu diikuti sendiri (cookie tiap hop, Fase 3b).
import { Readable } from 'node:stream';
import * as http from 'node:http';
import * as https from 'node:https';
import { createWriteStream, rm, type WriteStream } from 'node:fs';

/** body besar dari disk: `stream()` dipanggil tiap pengiriman (juga hop redirect 307/308); length = Content-Length */
export type BodyStream = { length: number; stream(): AsyncIterable<Buffer | Uint8Array> };
export type HttpRequest = { method: string; url: string; headers: [string, string][]; body?: string | Buffer | BodyStream };
const isBodyStream = (b: unknown): b is BodyStream => typeof b === 'object' && b !== null && typeof (b as BodyStream).stream === 'function';
export type SendOptions = {
  signal?: AbortSignal; timeoutMs?: number;
  /** default true; false = response 3xx dikembalikan apa adanya (# @no-redirect) */ followRedirects?: boolean;
  /** abaikan sertifikat SSL (# @insecure) */ insecure?: boolean;
  /** error sampingan yang tidak menggagalkan request (mis. hapus file body setengah jadi); host mencatatnya ke output channel */
  onError?: (where: string, e: unknown) => void;
  /** batas body di memory (default 1 MB); sisanya hanya di bodyFile */ maxMemory?: number;
  /** file tujuan body utuh bila body > maxMemory atau biner (tidak dibuat untuk body kecil) */ bodyFile?: string;
  /** cookie jar: header Cookie per hop + Set-Cookie tiap hop disimpan (redirect login ikut tercatat) */
  cookies?: { get(url: URL): string | undefined; set(url: URL, setCookies: string[]): void };
  /** hop redirect ke-n (1..10) akan diikuti: label loading `Following redirect n/10` */ onRedirect?: (n: number) => void;
};
export type HttpResponse = {
  status: number; statusText: string; headers: [string, string][];
  /** body di memory: utuh, atau potongan awal bila truncated, kosong bila biner */ body: Buffer;
  /** ukuran body dalam byte */ size: number; timeMs: number; url: string;
  truncated?: boolean; binary?: boolean; bodyFile?: string;
  /** hop redirect yang diikuti: status + URL asal + Set-Cookie hop itu (Timeline) */ redirects?: { status: number; url: string; setCookies?: string[] }[];
};
export type ErrorKind = 'timeout' | 'cancelled' | 'network';
export class RequestError extends Error {
  constructor(message: string, readonly kind: ErrorKind, options?: { cause?: unknown }) { super(message, options); }
}

export const DEFAULT_TIMEOUT_MS = 600_000;
/** batas waktu request: `# @timeout` (detik) > setting `httpme.request.timeout` (detik) > default 600 s (10 menit); nilai <= 0 / bukan angka diabaikan */
export function resolveTimeoutMs(requestSec: number | undefined, settingSec: number | undefined): number {
  const sec = [requestSec, settingSec].find((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
  return sec === undefined ? DEFAULT_TIMEOUT_MS : sec * 1000;
}
export const MAX_BODY_MEMORY = 1024 * 1024;

const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|x-yaml|x-ndjson)\b)|[+/](json|xml)\b/i;
const BINARY_TYPE = /^((image|audio|video|font)\/|application\/(pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|octet-stream|wasm|msword|vnd\.))/i;
/** body biner (gambar, PDF, zip, ...): tidak ditampilkan sebagai teks, hanya Save to file */
export const isBinaryType = (contentType: string): boolean => !TEXT_TYPE.test(contentType.trim()) && BINARY_TYPE.test(contentType.trim());

/** GET / HEAD tidak membawa body: body yang diketik tetap disimpan di .http, hanya tidak dikirim */
export const sendsBody = (method: string): boolean => !['GET', 'HEAD'].includes(method.toUpperCase());

/** OPTIONS: method yang didukung server dari Allow lalu Access-Control-Allow-Methods, tanpa duplikat */
export function allowedMethods(headers: [string, string][]): string[] {
  const out = new Set<string>();
  for (const name of ['allow', 'access-control-allow-methods']) {
    for (const [k, v] of headers) if (k === name) v.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean).forEach((m) => out.add(m));
  }
  return [...out];
}

/** header berulang (X-Multi: 1, X-Multi: 2) digabung dengan ", " seperti fetch; nama dipertahankan */
function headerObject(list: [string, string][]): http.OutgoingHttpHeaders {
  const out: Record<string, string> = {};
  const names = new Map<string, string>();
  for (const [k, v] of list) {
    const name = names.get(k.toLowerCase()) ?? k;
    names.set(k.toLowerCase(), name);
    out[name] = name in out ? `${out[name]}, ${v}` : v;
  }
  return out;
}

/** header response sebagai pasangan [nama huruf kecil, nilai]; Set-Cookie tetap satu baris per cookie */
function responseHeaders(raw: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < raw.length; i += 2) out.push([raw[i].toLowerCase(), raw[i + 1]]);
  return out;
}

const parseUrl = (raw: string, base?: URL): URL => {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch (e) {
    throw new RequestError(`Invalid URL: ${raw}`, 'network', { cause: e });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RequestError(`Unsupported protocol ${url.protocol} (use http:// or https://)`, 'network');
  return url;
};

export const MAX_REDIRECTS = 10;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** satu hop: kirim request, tunggu header response (body belum dibaca) */
function request(url: URL, method: string, headers: [string, string][], body: string | Buffer | BodyStream | undefined, signal: AbortSignal, insecure: boolean): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const h = headerObject(headers);
    // Node tidak memakai chunked untuk DELETE/OPTIONS: tanpa Content-Length body merusak koneksi
    if (body !== undefined && !Object.keys(h).some((k) => /^(content-length|transfer-encoding)$/i.test(k))) h['Content-Length'] = isBodyStream(body) ? body.length : Buffer.byteLength(body);
    const lib = url.protocol === 'https:' ? https : http;
    const r = lib.request(url, { method, headers: h, signal, rejectUnauthorized: !insecure }, resolve);
    r.on('error', reject);
    if (isBodyStream(body)) {
      const src = Readable.from(body.stream(), { objectMode: false });
      src.on('error', (e) => r.destroy(e)); // file hilang / tak terbaca di tengah kirim: request gagal dengan pesan aslinya
      src.pipe(r);
    } else r.end(body);
  });
}

/** baca body: potongan awal di memory, body besar / biner ditulis bertahap ke bodyFile */
function readBody(res: http.IncomingMessage, opts: SendOptions): Promise<{ body: Buffer; size: number; truncated: boolean; binary: boolean; bodyFile?: string }> {
  return new Promise((resolve, reject) => {
    const binary = isBinaryType(String(res.headers['content-type'] ?? ''));
    const max = opts.maxMemory ?? MAX_BODY_MEMORY;
    const chunks: Buffer[] = [];
    let kept = 0;
    let size = 0;
    let file: WriteStream | undefined;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (!file && opts.bodyFile && (binary || size > max)) {
        file = createWriteStream(opts.bodyFile, { mode: 0o600 });
        file.on('error', (e) => res.destroy(e));
        for (const k of chunks) file.write(k); // potongan yang sudah di memory ikut ditulis dulu
      }
      file?.write(c);
      if (!binary && kept < max) {
        const part = c.subarray(0, max - kept);
        chunks.push(part);
        kept += part.length;
      }
    });
    res.on('error', (e) => {
      if (file) {
        // body setengah jadi (cancel / putus) tidak boleh tertinggal di cache
        file.destroy();
        rm(opts.bodyFile!, { force: true }, (re) => re && opts.onError?.('readBody: remove partial body file', re));
      }
      reject(e);
    });
    res.on('end', () => {
      const done = () => resolve({ body: Buffer.concat(chunks), size, truncated: !binary && size > max, binary, bodyFile: file && opts.bodyFile });
      if (file) file.end(done);
      else done();
    });
  });
}

/** header Cookie milik request menang; cookie jar dengan nama lain ditambahkan ke header yang sama */
function withJar(headers: [string, string][], jar: string | undefined): [string, string][] {
  if (!jar) return headers;
  const i = headers.findIndex(([k]) => k.toLowerCase() === 'cookie');
  if (i < 0) return [...headers, ['Cookie', jar]];
  const own = new Set(headers[i][1].split(';').map((p) => p.split('=')[0].trim()));
  const extra = jar.split('; ').filter((p) => !own.has(p.split('=')[0]));
  return extra.length ? headers.map((h, j) => (j === i ? [h[0], `${h[1]}; ${extra.join('; ')}`] : h)) : headers;
}

/**
 * kirim request; redirect diikuti sendiri (maks 10) seperti fetch: 303 dan 301/302 untuk POST jadi GET tanpa body,
 * 307/308 tetap method + body, Authorization dibuang bila pindah origin.
 */
export async function send(req: HttpRequest, opts: SendOptions = {}): Promise<HttpResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let url = parseUrl(req.url);
  if (opts.signal?.aborted) throw new RequestError('Cancelled', 'cancelled');

  const started = performance.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const fail = (e: unknown): RequestError => {
    if (e instanceof RequestError) return e;
    if (opts.signal?.aborted) return new RequestError('Cancelled', 'cancelled', { cause: e });
    if (timeout.aborted) return new RequestError(`Request timed out after ${timeoutMs / 1000} s`, 'timeout', { cause: e });
    return new RequestError(e instanceof Error ? e.message : String(e), 'network', { cause: e });
  };

  let method = req.method;
  let headers = req.headers;
  let body = sendsBody(method) ? req.body : undefined;
  const redirects: { status: number; url: string; setCookies?: string[] }[] = [];
  try {
    for (;;) {
      const res = await request(url, method, opts.cookies ? withJar(headers, opts.cookies.get(url)) : headers, body, signal, !!opts.insecure);
      const status = res.statusCode ?? 0;
      const setCookies = res.headers['set-cookie'] ?? [];
      if (opts.cookies && setCookies.length) opts.cookies.set(url, setCookies);
      const location = res.headers.location;
      if (opts.followRedirects === false || !REDIRECT.has(status) || !location) {
        const b = await readBody(res, opts);
        return {
          status, statusText: res.statusMessage ?? '', headers: responseHeaders(res.rawHeaders), ...b,
          timeMs: Math.round(performance.now() - started), url: url.href, redirects,
        };
      }
      res.resume(); // body halaman redirect tidak dipakai
      if (redirects.length >= MAX_REDIRECTS) throw new RequestError(`Too many redirects (${MAX_REDIRECTS})`, 'network');
      redirects.push({ status, url: url.href, ...(setCookies.length ? { setCookies } : {}) });
      opts.onRedirect?.(redirects.length);
      const next = parseUrl(location, url);
      if (status === 303 ? method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST') {
        method = 'GET';
        body = undefined;
        headers = headers.filter(([k]) => !/^content-(type|length)$/i.test(k));
      }
      if (next.origin !== url.origin) headers = headers.filter(([k]) => k.toLowerCase() !== 'authorization');
      url = next;
    }
  } catch (e) {
    throw fail(e);
  }
}
