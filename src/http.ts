// kirim request HTTP (tanpa vscode). Pakai node:http/https, bukan fetch: fetch Node tidak bisa "abaikan SSL" per request
// tanpa undici, dan redirect perlu diikuti sendiri (cookie tiap hop, Fase 3b).
import * as http from 'node:http';
import * as https from 'node:https';

export type HttpRequest = { method: string; url: string; headers: [string, string][]; body?: string | Buffer };
export type SendOptions = { signal?: AbortSignal; timeoutMs?: number };
export type HttpResponse = {
  status: number; statusText: string; headers: [string, string][]; body: Buffer;
  /** ukuran body dalam byte */ size: number; timeMs: number; url: string;
};
export type ErrorKind = 'timeout' | 'cancelled' | 'network';
export class RequestError extends Error {
  constructor(message: string, readonly kind: ErrorKind, options?: { cause?: unknown }) { super(message, options); }
}

export const DEFAULT_TIMEOUT_MS = 30_000;

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

export async function send(req: HttpRequest, opts: SendOptions = {}): Promise<HttpResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch (e) {
    throw new RequestError(`Invalid URL: ${req.url}`, 'network', { cause: e });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RequestError(`Unsupported protocol ${url.protocol} (use http:// or https://)`, 'network');
  if (opts.signal?.aborted) throw new RequestError('Cancelled', 'cancelled');

  const started = performance.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const fail = (e: unknown): RequestError => {
    if (opts.signal?.aborted) return new RequestError('Cancelled', 'cancelled', { cause: e });
    if (timeout.aborted) return new RequestError(`Request timed out after ${timeoutMs / 1000} s`, 'timeout', { cause: e });
    return new RequestError(e instanceof Error ? e.message : String(e), 'network', { cause: e });
  };

  return new Promise<HttpResponse>((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const body = sendsBody(req.method) ? req.body : undefined;
    const headers = headerObject(req.headers);
    // Node tidak memakai chunked untuk DELETE/OPTIONS: tanpa Content-Length body merusak koneksi
    if (body !== undefined && !Object.keys(headers).some((k) => /^(content-length|transfer-encoding)$/i.test(k))) headers['Content-Length'] = Buffer.byteLength(body);
    const r = lib.request(url, { method: req.method, headers, signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => { chunks.push(c); size += c.length; });
      res.on('error', (e) => reject(fail(e)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers: responseHeaders(res.rawHeaders),
        body: Buffer.concat(chunks), size, timeMs: Math.round(performance.now() - started), url: url.href,
      }));
    });
    r.on('error', (e) => reject(fail(e)));
    r.end(body);
  });
}
