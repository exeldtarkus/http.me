// baca/tulis satu request file .http (format REST Client / JetBrains), tanpa vscode.
// Satu file = satu request (Save selalu 1 request); file multi-request dipecah splitBlocks lalu tiap blok di-parse.
export type BodyType = 'none' | 'json' | 'text' | 'xml' | 'form';
export type Header = { name: string; value: string; enabled: boolean };
export type Param = { key: string; value: string };
export type ParsedRequest = {
  /** teks setelah `###` = judul tampil (tab, sidebar, History); undefined = tanpa baris ### */ title: string | undefined;
  /** `# @name` = ID request standar */ name: string | undefined;
  /** komentar & baris lain di atas request yang bukan metadata http.me, dipertahankan apa adanya */
  preamble: string[];
  method: string; url: string; headers: Header[];
  /** query param yang dimatikan (# @disabled key=value); yang aktif ada di URL */
  disabledParams: Param[];
  body: string; bodyType: BodyType;
  followRedirects: boolean; insecure: boolean; timeoutSec: number | undefined;
};

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'QUERY'];
const REQUEST_LINE = new RegExp(`^(${METHODS.join('|')})\\s+(.+?)(?:\\s+HTTP/[\\d.]+)?$`, 'i');
const HEADER_LINE = /^([^:\s][^:]*):\s?(.*)$/;

export function bodyTypeOf(contentType: string | undefined, body: string): BodyType {
  if (body === '') return 'none';
  const ct = (contentType ?? '').toLowerCase();
  if (/[/+]json\b/.test(ct)) return 'json';
  if (/[/+]xml\b/.test(ct)) return 'xml';
  if (ct.includes('application/x-www-form-urlencoded')) return 'form';
  return 'text';
}

export const emptyRequest = (): ParsedRequest => ({
  title: undefined, name: undefined, preamble: [], method: 'GET', url: '', headers: [], disabledParams: [], body: '', bodyType: 'none',
  followRedirects: true, insecure: false, timeoutSec: undefined,
});

export function parseRequest(text: string): ParsedRequest {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const r = emptyRequest();
  const disabled: Header[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '') continue;
    const title = /^###(.*)$/.exec(t);
    if (title && r.title === undefined) { r.title = title[1].trim(); continue; }
    const meta = /^(?:#|\/\/)\s*@([\w-]+)\s*(.*)$/.exec(t);
    if (meta?.[1] === 'name' && meta[2]) { r.name = meta[2].trim(); continue; }
    if (meta?.[1] === 'no-redirect') { r.followRedirects = false; continue; }
    if (meta?.[1] === 'insecure') { r.insecure = true; continue; }
    if (meta?.[1] === 'timeout' && /^\d+/.test(meta[2])) { r.timeoutSec = parseInt(meta[2], 10); continue; }
    if (meta?.[1] === 'disabled' && meta[2]) {
      const h = HEADER_LINE.exec(meta[2]);
      if (h && !h[1].includes('=')) disabled.push({ name: h[1].trim(), value: h[2], enabled: false });
      else { const eq = meta[2].indexOf('='); r.disabledParams.push(eq < 0 ? { key: meta[2], value: '' } : { key: meta[2].slice(0, eq), value: meta[2].slice(eq + 1) }); }
      continue;
    }
    if (/^(#|\/\/|<|@[\w-]+\s*=)/.test(t)) { r.preamble.push(lines[i]); continue; }
    break;
  }
  if (i < lines.length) {
    const t = lines[i].trim();
    const m = REQUEST_LINE.exec(t);
    r.method = m ? m[1].toUpperCase() : 'GET';
    r.url = m ? m[2] : t;
    for (i++; i < lines.length && lines[i].trim() !== ''; i++) {
      const h = HEADER_LINE.exec(lines[i]);
      if (h) r.headers.push({ name: h[1].trim(), value: h[2], enabled: true });
    }
    const body = lines.slice(i + 1);
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    r.body = body.join('\n');
  }
  r.headers.push(...disabled);
  const ct = r.headers.find((h) => h.enabled && h.name.toLowerCase() === 'content-type')?.value;
  r.bodyType = bodyTypeOf(ct, r.body);
  return r;
}

export function serializeRequest(r: ParsedRequest): string {
  const out: string[] = [];
  if (r.title !== undefined) out.push(`### ${r.title}`.trimEnd());
  if (r.name) out.push(`# @name ${r.name}`);
  if (!r.followRedirects) out.push('# @no-redirect');
  if (r.insecure) out.push('# @insecure');
  if (r.timeoutSec !== undefined) out.push(`# @timeout ${r.timeoutSec}`);
  for (const h of r.headers) if (!h.enabled) out.push(`# @disabled ${h.name}: ${h.value}`);
  for (const p of r.disabledParams) out.push(`# @disabled ${p.value === '' ? p.key : `${p.key}=${p.value}`}`);
  out.push(...r.preamble);
  out.push(`${r.method} ${r.url}`);
  for (const h of r.headers) if (h.enabled) out.push(`${h.name}: ${h.value}`);
  if (r.body !== '') out.push('', r.body);
  return `${out.join('\n')}\n`;
}

/** request siap kirim: header nonaktif dibuang, body kosong = tanpa body */
export const toHttpRequest = (r: ParsedRequest): { method: string; url: string; headers: [string, string][]; body: string | undefined } => ({
  method: r.method, url: r.url,
  headers: r.headers.filter((h) => h.enabled && h.name !== '').map((h): [string, string] => [h.name, h.value]),
  body: r.body === '' ? undefined : r.body,
});
