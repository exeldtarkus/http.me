// tampilan response untuk panel (tanpa vscode): status, waktu, ukuran, body JSON pretty + warna, header
import { parseSetCookie } from './cookieJar';
import { esc } from './webviewPage';
import { allowedMethods, MAX_BODY_MEMORY, type HttpResponse } from './http';

export type ResponseView = {
  status: string; statusClass: string; time: string; size: string;
  headers: [string, string][];
  /** cara body ditampilkan, dari Content-Type */ format: 'JSON' | 'XML' | 'HTML' | 'CSV' | 'Text' | 'Binary';
  /** body siap innerHTML (sudah di-escape) */
  bodyHtml: string;
  /** HEAD: hanya tab Headers */ head: boolean;
  /** OPTIONS: method dari Allow / Access-Control-Allow-Methods */ allow?: string[];
  /** body terpotong / biner */ note?: string;
  /** Open in editor (body > 1 MB) / Save to file (body ada di file cache) */ canOpen: boolean; canSave: boolean;
  /** tab Cookies: Set-Cookie dari semua hop */ cookies: { name: string; value: string; domain: string; path: string; expires?: string; session: boolean; httpOnly: boolean; secure: boolean }[];
  /** tab Timeline: hop redirect lalu response akhir, nama cookie yang di-set tiap hop */ timeline: { status: number; url: string; cookies: string[] }[];
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

/** rapikan XML: indent 2 spasi, <b>teks</b> pendek tetap satu baris. shortcut: CDATA / teks campuran berisi '<' tidak dirapikan sempurna */
export function prettyXml(xml: string): string | undefined {
  const tokens = xml.trim().replace(/>\s+</g, '><').split(/(<[^>]+>)/).filter((t) => t.trim() !== '');
  if (!tokens.length || !tokens[0].startsWith('<')) return undefined;
  const isOpen = (t?: string) => !!t && /^<[A-Za-z_][^>]*>$/.test(t) && !t.endsWith('/>');
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      out.push(`${'  '.repeat(depth)}${t}`);
    } else if (isOpen(t) && tokens[i + 2]?.startsWith('</') && !tokens[i + 1].startsWith('<')) {
      out.push(`${'  '.repeat(depth)}${t}${tokens[i + 1].trim()}${tokens[i + 2]}`);
      i += 2;
    } else {
      out.push(`${'  '.repeat(depth)}${t.startsWith('<') ? t : t.trim()}`);
      if (isOpen(t)) depth++;
    }
  }
  return out.join('\n');
}

const MARKUP = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g;

/** warna XML / HTML: tanda < > (.p), nama tag (.t), nama atribut (.a), nilai atribut (.s), komentar (.c); semua teks di-escape */
export function highlightMarkup(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(MARKUP)) {
    out += esc(text.slice(last, m.index));
    if (m[2] === undefined) out += `<span class="c">${esc(m[0])}</span>`;
    else {
      const word = (p: string) => p.split(/([\w:.-]+)/).map((q, j) => (j % 2 ? `<span class="a">${esc(q)}</span>` : esc(q))).join('');
      const attrs = m[3].split(/("[^"]*"|'[^']*')/).map((p, i) => (i % 2 ? `<span class="s">${esc(p)}</span>` : word(p))).join('');
      out += `<span class="p">&lt;${m[1]}</span><span class="t">${esc(m[2])}</span>${attrs}<span class="p">${m[4]}&gt;</span>`;
    }
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

/** CSV RFC 4180: kutip, "" di dalam kutip, koma / baris baru di dalam kutip; pemisah ; bila baris pertama lebih banyak ; */
export function parseCsv(text: string): string[][] {
  if (text === '') return [];
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const sep = (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export const MAX_CSV_ROWS = 1000;

function csvTable(rows: string[][]): string {
  const [head = [], ...body] = rows;
  const cells = (r: string[], tag: string) => r.map((c) => `<${tag}>${esc(c)}</${tag}>`).join('');
  return `<table class="csv"><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${body.slice(0, MAX_CSV_ROWS).map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody></table>`;
}

export function responseView(res: HttpResponse, method: string): ResponseView {
  const text = res.body.toString('utf8');
  const ct = res.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
  let format: ResponseView['format'] = 'Text';
  let bodyHtml = esc(text);
  let note = res.binary ? `Binary body (${ct || 'unknown type'}, ${formatSize(res.size)}).`
    : res.truncated ? `Showing the first ${formatSize(MAX_BODY_MEMORY)} of ${formatSize(res.size)}.` : undefined;
  const pretty = !res.truncated && (/[/+]json\b/i.test(ct) || /^\s*[[{]/.test(text)) ? prettyJson(text) : undefined;
  if (res.binary) { format = 'Binary'; bodyHtml = ''; }
  else if (pretty !== undefined) { format = 'JSON'; bodyHtml = highlightJson(pretty); }
  else if (/[/+]json\b/i.test(ct)) format = 'JSON';
  else if (/^(text|application)\/csv\b/i.test(ct)) {
    format = 'CSV';
    const rows = parseCsv(text);
    bodyHtml = csvTable(rows);
    if (rows.length - 1 > MAX_CSV_ROWS) note ??= `Showing the first ${MAX_CSV_ROWS.toLocaleString('en-US')} of ${(rows.length - 1).toLocaleString('en-US')} rows.`;
  } else if (/html/i.test(ct)) { format = 'HTML'; bodyHtml = highlightMarkup(text); }
  else if (/[/+]xml\b/i.test(ct)) { format = 'XML'; bodyHtml = highlightMarkup((!res.truncated && prettyXml(text)) || text); }
  // cookie tiap hop: URL hop menentukan domain default
  const hops = [...(res.redirects ?? []).map((r) => ({ status: r.status, url: r.url, set: r.setCookies ?? [] })),
    { status: res.status, url: res.url, set: res.headers.filter(([k]) => k === 'set-cookie').map(([, v]) => v) }];
  const cookies: ResponseView['cookies'] = [];
  const timeline = hops.map((h) => {
    const names: string[] = [];
    for (const raw of h.set) {
      let c;
      try { c = parseSetCookie(raw, new URL(h.url), Date.now()); } catch { c = undefined; } // URL hop tidak valid: cookie dilewati
      if (!c) continue;
      names.push(c.name);
      cookies.push({ name: c.name, value: c.value, domain: c.domain, path: c.path, ...(c.expires !== undefined ? { expires: new Date(c.expires).toUTCString() } : {}), session: c.expires === undefined, httpOnly: c.httpOnly, secure: c.secure });
    }
    return { status: h.status, url: h.url, cookies: names };
  });
  return {
    cookies, timeline,
    status: `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
    statusClass: statusClass(res.status),
    time: formatTime(res.timeMs),
    size: formatSize(res.size),
    headers: res.headers,
    format,
    bodyHtml,
    head: method === 'HEAD',
    allow: method === 'OPTIONS' ? allowedMethods(res.headers) : undefined,
    note,
    canOpen: !!res.truncated && !!res.bodyFile,
    canSave: !!res.bodyFile,
  };
}
