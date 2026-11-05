// baca/tulis satu request file .http (format REST Client / JetBrains), tanpa vscode.
// Satu file = satu request (Save selalu 1 request); file multi-request dipecah splitBlocks lalu tiap blok di-parse.
export type BodyType = 'none' | 'json' | 'text' | 'xml' | 'form';
export type Header = { name: string; value: string; enabled: boolean };
export type Param = { key: string; value: string };
export type FileVar = { name: string; value: string };
export type ParsedRequest = {
  /** variabel file `@name = value` di atas file (resolusi {{var}} di vars.ts, Fase 3) */ vars: FileVar[];
  /** teks setelah `###` = judul tampil (tab, sidebar, History); undefined = tanpa baris ### */ title: string | undefined;
  /** `# @name` = ID request standar */ name: string | undefined;
  /** komentar & baris lain di atas request yang bukan metadata http.me, dipertahankan apa adanya */
  preamble: string[];
  method: string; url: string; headers: Header[];
  /** query param yang dimatikan (# @disabled key=value); yang aktif ada di URL */
  disabledParams: Param[];
  body: string; bodyType: BodyType;
  followRedirects: boolean; insecure: boolean; timeoutSec: number | undefined;
  /** # @no-cookie-jar: cookie tersimpan tidak dikirim / disimpan */ noCookieJar: boolean;
  /** # @no-send-cookies: cookie jar tidak dikirim */ noSendCookies: boolean;
  /** # @no-save-cookies: Set-Cookie dari response tidak disimpan */ noSaveCookies: boolean;
  /** # @login: request login Environment */ login: boolean;
  /** # @operation: operationId asal OpenAPI */ operation: string | undefined;
  /** # @auth …: auth yang bukan header standar (teks mentah setelah @auth) */ auth: string | undefined;
  noScripts: boolean; noPre: boolean; noPost: boolean;
  /** `< ./x.js` / `< {% … %}` sebelum baris request (dijalankan di Fase 3c) */ preScripts: string[];
  /** `> ./x.js` / `> {% … %}` setelah body */ postScripts: string[];
  /** `< ./body.json` sebagai body: isi dibaca dari file saat Send */ bodyFile: string | undefined;
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
  vars: [], title: undefined, name: undefined, preamble: [], method: 'GET', url: '', headers: [], disabledParams: [], body: '', bodyType: 'none',
  followRedirects: true, insecure: false, timeoutSec: undefined,
  noCookieJar: false, noSendCookies: false, noSaveCookies: false, login: false, operation: undefined, auth: undefined, noScripts: false, noPre: false, noPost: false,
  preScripts: [], postScripts: [], bodyFile: undefined,
});

/** script `<` / `>` mulai di lines[i]: path, atau inline {% … %} (bisa multi-baris); kembalikan isi + indeks baris terakhir */
function readScript(lines: string[], i: number): { script: string; end: number } {
  const first = lines[i].trim().slice(1).trim();
  if (!first.startsWith('{%') || first.includes('%}')) return { script: first, end: i };
  const parts = [first];
  let j = i + 1;
  for (; j < lines.length; j++) {
    parts.push(lines[j]);
    if (lines[j].includes('%}')) break;
  }
  return { script: parts.join('\n'), end: Math.min(j, lines.length - 1) };
}
const POST_LINE = /^>\s*\S/;

/** metadata tanpa nilai: nama -> field boolean */
const FLAGS = { 'no-cookie-jar': 'noCookieJar', 'no-send-cookies': 'noSendCookies', 'no-save-cookies': 'noSaveCookies', login: 'login', 'no-scripts': 'noScripts', 'no-pre': 'noPre', 'no-post': 'noPost' } as const;

/** baris metadata # @… / // @…: diterapkan ke request; false = bukan metadata http.me (komentar biasa) */
function applyMeta(r: ParsedRequest, disabled: Header[], t: string): boolean {
  const meta = /^(?:#|\/\/)\s*@([\w-]+)\s*(.*)$/.exec(t);
  if (meta?.[1] === 'name' && meta[2]) { r.name = meta[2].trim(); return true; }
  if (meta?.[1] === 'no-redirect') { r.followRedirects = false; return true; }
  if (meta?.[1] === 'insecure') { r.insecure = true; return true; }
  if (meta && meta[1] in FLAGS) { r[FLAGS[meta[1] as keyof typeof FLAGS]] = true; return true; }
  if (meta?.[1] === 'operation' && meta[2]) { r.operation = meta[2].trim(); return true; }
  if (meta?.[1] === 'auth' && meta[2]) { r.auth = meta[2].trim(); return true; }
  if (meta?.[1] === 'timeout' && /^\d+/.test(meta[2])) { r.timeoutSec = parseInt(meta[2], 10); return true; }
  if (meta?.[1] === 'disabled' && meta[2]) {
    const h = HEADER_LINE.exec(meta[2]);
    if (h && !h[1].includes('=')) disabled.push({ name: h[1].trim(), value: h[2], enabled: false });
    else { const eq = meta[2].indexOf('='); r.disabledParams.push(eq < 0 ? { key: meta[2], value: '' } : { key: meta[2].slice(0, eq), value: meta[2].slice(eq + 1) }); }
    return true;
  }
  return false;
}

export function parseRequest(text: string): ParsedRequest {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const r = emptyRequest();
  const disabled: Header[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '') continue;
    const v = /^@([\w.-]+)\s*=\s*(.*)$/.exec(t);
    if (v) { r.vars.push({ name: v[1], value: v[2].trim() }); continue; }
    const title = /^###(.*)$/.exec(t);
    if (title && r.title === undefined) { r.title = title[1].trim(); continue; }
    if (applyMeta(r, disabled, t)) continue;
    if (t.startsWith('<')) { const sc = readScript(lines, i); r.preScripts.push(sc.script); i = sc.end; continue; }
    if (/^(#|\/\/)/.test(t)) { r.preamble.push(lines[i]); continue; }
    break;
  }
  if (i < lines.length) {
    const t = lines[i].trim();
    const m = REQUEST_LINE.exec(t);
    r.method = m ? m[1].toUpperCase() : 'GET';
    r.url = m ? m[2] : t;
    for (i++; i < lines.length && lines[i].trim() !== ''; i++) {
      const t2 = lines[i].trim();
      // komentar / metadata di tengah header: bukan header
      if (/^(#|\/\/)/.test(t2)) { if (!applyMeta(r, disabled, t2)) r.preamble.push(lines[i]); continue; }
      const h = HEADER_LINE.exec(lines[i]);
      if (h) r.headers.push({ name: h[1].trim(), value: h[2], enabled: true });
    }
    // body sampai baris `> script` pertama; sisanya post-script
    const rest = lines.slice(i + 1);
    let end = rest.findIndex((l) => POST_LINE.test(l.trim()));
    if (end < 0) end = rest.length;
    for (let j = end; j < rest.length; j++) {
      if (!POST_LINE.test(rest[j].trim())) continue;
      const sc = readScript(rest, j);
      r.postScripts.push(sc.script);
      j = sc.end;
    }
    const body = rest.slice(0, end);
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    const fromFile = body.length === 1 ? /^<\s*(\S.*)$/.exec(body[0].trim()) : null;
    if (fromFile && !fromFile[1].startsWith('{%')) r.bodyFile = fromFile[1].trim();
    else r.body = body.join('\n');
  }
  r.headers.push(...disabled);
  const ct = r.headers.find((h) => h.enabled && h.name.toLowerCase() === 'content-type')?.value;
  r.bodyType = bodyTypeOf(ct, r.body);
  return r;
}

export function serializeRequest(r: ParsedRequest): string {
  const out: string[] = r.vars.map((v) => `@${v.name} = ${v.value}`);
  if (out.length) out.push('');
  if (r.title !== undefined) out.push(`### ${r.title}`.trimEnd());
  if (r.name) out.push(`# @name ${r.name}`);
  if (!r.followRedirects) out.push('# @no-redirect');
  if (r.noCookieJar) out.push('# @no-cookie-jar');
  if (r.noSendCookies) out.push('# @no-send-cookies');
  if (r.noSaveCookies) out.push('# @no-save-cookies');
  if (r.timeoutSec !== undefined) out.push(`# @timeout ${r.timeoutSec}`);
  if (r.insecure) out.push('# @insecure');
  if (r.login) out.push('# @login');
  for (const h of r.headers) if (!h.enabled) out.push(`# @disabled ${h.name}: ${h.value}`);
  for (const p of r.disabledParams) out.push(`# @disabled ${p.value === '' ? p.key : `${p.key}=${p.value}`}`);
  if (r.operation) out.push(`# @operation ${r.operation}`);
  if (r.auth) out.push(`# @auth ${r.auth}`);
  if (r.noScripts) out.push('# @no-scripts');
  if (r.noPre) out.push('# @no-pre');
  if (r.noPost) out.push('# @no-post');
  out.push(...r.preamble);
  for (const sc of r.preScripts) out.push(`< ${sc}`);
  out.push(`${r.method} ${r.url}`);
  for (const h of r.headers) if (h.enabled) out.push(`${h.name}: ${h.value}`);
  if (r.bodyFile) out.push('', `< ${r.bodyFile}`);
  else if (r.body !== '') out.push('', r.body);
  if (r.postScripts.length) out.push('', ...r.postScripts.map((sc) => `> ${sc}`));
  return `${out.join('\n')}\n`;
}

export type SendableRequest = { method: string; url: string; headers: [string, string][]; body: string | Buffer | undefined };

/** request siap kirim: header nonaktif dibuang, body kosong = tanpa body */
/** opsi cookie jar request: kirim cookie tersimpan / simpan Set-Cookie (default keduanya) */
export const cookieFlags = (r: ParsedRequest): { send: boolean; save: boolean } =>
  ({ send: !r.noCookieJar && !r.noSendCookies, save: !r.noCookieJar && !r.noSaveCookies });

export const toHttpRequest = (r: ParsedRequest): SendableRequest => ({
  method: r.method, url: r.url,
  headers: r.headers.filter((h) => h.enabled && h.name !== '').map((h): [string, string] => [h.name, h.value]),
  body: r.body === '' ? undefined : r.body,
});

/** seperti toHttpRequest, body `< ./file` dibaca lewat readFile (path relatif ke file .http, diselesaikan pemanggil) */
export async function toHttpRequestWithFile(r: ParsedRequest, readFile: (path: string) => Promise<Buffer>): Promise<SendableRequest> {
  const req = toHttpRequest(r);
  return r.bodyFile ? { ...req, body: await readFile(r.bodyFile) } : req;
}

export type Block = { /** baris ### (atau baris pertama) */ start: number; /** baris terakhir yang tidak kosong */ end: number; text: string };

/**
 * pecah file multi-request per `###`. Bagian sebelum ### pertama: bila berisi request = blok sendiri,
 * bila hanya variabel / komentar = variabelnya ikut ke tiap blok. Blok tanpa baris request dilewati.
 */
export function splitBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cuts = lines.map((l, i) => (l.trim().startsWith('###') ? i : -1)).filter((i) => i > 0);
  const segments = [0, ...cuts].map((start, k) => ({ start, end: (k < cuts.length ? cuts[k] : lines.length) - 1 }));
  const hasRequest = (t: string) => parseRequest(t).url !== '';
  let prefix: string[] = [];
  const out: Block[] = [];
  for (const [k, seg] of segments.entries()) {
    let end = seg.end;
    while (end > seg.start && lines[end].trim() === '') end--;
    const body = lines.slice(seg.start, end + 1).join('\n');
    if (!hasRequest(body)) {
      // bagian kepala file tanpa request: variabel file dibagikan ke semua blok
      if (k === 0 && !lines[0].trim().startsWith('###')) prefix = lines.slice(seg.start, end + 1).filter((l) => /^\s*@[\w.-]+\s*=/.test(l));
      continue;
    }
    out.push({ start: seg.start, end, text: [...prefix, body].join('\n') + '\n' });
  }
  return out;
}

/** tulis ulang blok ke-index (file multi-request) dari request panel; variabel kepala file tidak ikut ditulis ke blok */
export function replaceBlock(text: string, index: number, r: ParsedRequest): string {
  const b = splitBlocks(text)[index];
  if (!b) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const own = parseRequest(lines.slice(b.start, b.end + 1).join('\n')).vars.length;
  const shared = parseRequest(b.text).vars.length - own;
  const block = serializeRequest({ ...r, vars: r.vars.slice(shared) }).replace(/\n$/, '').split('\n');
  return [...lines.slice(0, b.start), ...block, ...lines.slice(b.end + 1)].join(eol);
}

/** label tab request: judul ###, lalu # @name, lalu METHOD + path (tanpa host / query) */
export function blockLabel(r: ParsedRequest): string {
  if (r.title) return r.title;
  if (r.name) return r.name;
  const path = r.url.replace(/^(?:[a-z][\w+.-]*:\/\/[^/]*|\{\{[^}]*\}\})/i, '').replace(/[?#].*$/, '');
  return `${r.method} ${path || '/'}`;
}
