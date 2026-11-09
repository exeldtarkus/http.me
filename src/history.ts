// History request (tanpa vscode): 1 chunk per request di httpme-cache/history/, 200 terakhir;
// teks .http asli ({{var}} belum diganti) tanpa header secret / cookie, body > 64 KB tidak disimpan
import { promises as fs } from 'node:fs';
import { clearCache, prune, readChunks, remove, writeChunk } from './cache';
import { responseView, type ResponseView } from './response';
import { serializeRequest, type ParsedRequest } from './httpFile';
import type { HistorySummary } from './runningStatus';

export const HISTORY_MAX = 200;
const MAX_BODY = 64 * 1024;
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

export type HistoryResponse = { contentType?: string; /** body teks, maks 64 KB */ body?: string };
export type HistoryEntry = HistorySummary & { title?: string; /** response terakhir (untuk contoh / schema saat export OpenAPI) */ response?: HistoryResponse; /** blok ke-n di file multi-request */ block?: number; /** request sebagai teks .http */ text: string; note?: string };
export type HistoryInput = Omit<HistorySummary, 'method' | 'url'> & { request: ParsedRequest; block?: number; response?: HistoryResponse };

/** id = waktu (15 digit) + urutan: urutan teks = urutan waktu */
export const historyId = (time: number, seq: number): string => `${String(time).padStart(15, '0')}-${String(seq).padStart(6, '0')}`;

export function historyEntry(i: HistoryInput): HistoryEntry {
  const big = Buffer.byteLength(i.request.body) > MAX_BODY;
  const r: ParsedRequest = { ...i.request, headers: i.request.headers.filter((h) => !SECRET_HEADERS.has(h.name.toLowerCase())), ...(big ? { body: '' } : {}) };
  const { request: _r, response, ...rest } = i;
  const keep = response && (response.body === undefined || Buffer.byteLength(response.body) <= MAX_BODY) ? response : response && { ...(response.contentType ? { contentType: response.contentType } : {}) };
  return {
    ...rest, ...(keep && Object.keys(keep).length ? { response: keep } : {}), method: r.method, url: r.url, ...(r.title ? { title: r.title } : {}),
    text: serializeRequest(r), ...(big ? { note: 'Body not saved (larger than 64 KB).' } : {}),
  };
}

export async function listHistory(dir: string): Promise<HistoryEntry[]> {
  return (await readChunks<HistoryEntry>(dir)).sort(([a], [b]) => (a < b ? 1 : -1)).map(([, e]) => e);
}

/** simpan lalu buang yang lebih lama dari 200 terakhir */
export async function addHistory(dir: string, e: HistoryEntry): Promise<void> {
  await writeChunk(dir, e.id, e);
  // cukup nama file (id = urutan waktu), isi chunk tidak dibaca
  const ids = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).map((n) => decodeURIComponent(n.slice(0, -5))).sort().reverse();
  if (ids.length > HISTORY_MAX) await prune(dir, ids.slice(0, HISTORY_MAX));
}

export const removeHistory = (dir: string, id: string) => remove(dir, id);
export const clearHistory = (dir: string) => clearCache(dir);

export type HistoryView = ({ kind: 'response' } & ResponseView) | { kind: 'error'; message: string } | { kind: 'cancelled' };

const two = (n: number) => String(n).padStart(2, '0');
/** waktu lokal `YYYY-MM-DD HH:mm:ss` */
const stamp = (t: number): string => { const d = new Date(t); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };

/** tampilan response sebuah entri History (headers tidak disimpan; body hanya bila <= 64 KB) */
export function historyView(e: HistoryEntry): HistoryView {
  if (e.cancelled) return { kind: 'cancelled' };
  if (e.error) return { kind: 'error', message: `${e.error} (from History: executed ${stamp(e.time)})` };
  const body = Buffer.from(e.response?.body ?? '', 'utf8');
  const headers: [string, string][] = e.response?.contentType ? [['content-type', e.response.contentType]] : [];
  const v = responseView({ status: e.status ?? 0, statusText: '', headers, body, size: body.length, timeMs: e.ms ?? 0, url: e.url }, e.method);
  const note = `From History: executed ${stamp(e.time)}. ${e.response?.body === undefined ? 'Response body and headers were not saved.' : 'Headers were not saved.'}`;
  return { kind: 'response', ...v, note: v.note ? `${note} ${v.note}` : note };
}
