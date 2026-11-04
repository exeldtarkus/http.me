// tampilan response untuk panel (tanpa vscode): status, waktu, ukuran, body JSON pretty + warna, header
import { esc } from './webviewPage';
import { allowedMethods, type HttpResponse } from './http';

export type ResponseView = {
  status: string; statusClass: string; time: string; size: string;
  headers: [string, string][];
  /** body siap innerHTML (sudah di-escape) */
  bodyHtml: string;
  /** HEAD: hanya tab Headers */ head: boolean;
  /** OPTIONS: method dari Allow / Access-Control-Allow-Methods */ allow?: string[];
};

export const statusClass = (s: number): string => (s >= 100 && s < 500 ? `st-${Math.floor(s / 100)}` : 'st-5');

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const formatTime = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);

export function prettyJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined; // bukan JSON valid: sengaja, ditampilkan sebagai teks biasa
  }
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

/** warna JSON: key (.k), string (.s), angka & literal (.n); semua teks di-escape */
export function highlightJson(json: string): string {
  let out = '';
  let last = 0;
  for (const m of json.matchAll(TOKEN)) {
    out += esc(json.slice(last, m.index));
    if (m[1] !== undefined) out += m[2] !== undefined ? `<span class="k">${esc(m[1])}</span>${m[2]}` : `<span class="s">${esc(m[1])}</span>`;
    else out += `<span class="n">${m[3] ?? m[4]}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(json.slice(last));
}

export function responseView(res: HttpResponse, method: string): ResponseView {
  const text = res.body.toString('utf8');
  const ct = res.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
  const pretty = /[/+]json\b/i.test(ct) || /^\s*[[{]/.test(text) ? prettyJson(text) : undefined;
  return {
    status: `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
    statusClass: statusClass(res.status),
    time: formatTime(res.timeMs),
    size: formatSize(res.size),
    headers: res.headers,
    bodyHtml: pretty !== undefined ? highlightJson(pretty) : esc(text),
    head: method === 'HEAD',
    allow: method === 'OPTIONS' ? allowedMethods(res.headers) : undefined,
  };
}
