// cURL dialek bash (tanpa vscode): tokenizer, perintah -> request (untuk paste / import, bukan format simpan), request -> perintah
import { bodyTypeOf, emptyRequest, type ParsedRequest } from './httpFile';
import { sendsBody } from './http';

const ANSI: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '0': '\0' };

/** pecah perintah bash jadi argumen: '…' literal, "…" dengan escape \" \\ \$ \`, $'…' escape ANSI-C, \x di luar kutip, \ + baris baru = sambung */
export function tokenize(src: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  const unclosed = () => new Error('Unclosed quote in the curl command');
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) { i += src[i + 1] === '\r' ? 3 : 2; continue; }
    if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } i++; continue; }
    has = true;
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw unclosed();
      cur += src.slice(i + 1, j);
      i = j + 1;
    } else if (c === '$' && src[i + 1] === "'") {
      for (i += 2; ; i++) {
        if (i >= src.length) throw unclosed();
        if (src[i] === "'") { i++; break; }
        if (src[i] !== '\\') { cur += src[i]; continue; }
        const e = src[++i];
        if (e === 'x' && /^[0-9a-f]{1,2}/i.test(src.slice(i + 1, i + 3))) {
          const hex = /^[0-9a-f]{1,2}/i.exec(src.slice(i + 1, i + 3))![0];
          cur += String.fromCharCode(parseInt(hex, 16));
          i += hex.length;
        } else cur += ANSI[e] ?? `\\${e}`;
      }
    } else if (c === '"') {
      for (i++; ; ) {
        if (i >= src.length) throw unclosed();
        if (src[i] === '"') { i++; break; }
        if (src[i] === '\\' && '"\\$`\n'.includes(src[i + 1])) { if (src[i + 1] !== '\n') cur += src[i + 1]; i += 2; } else cur += src[i++];
      }
    } else if (c === '\\') {
      cur += src[i + 1] ?? '';
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

const VALUE: Record<string, string> = {
  '-X': 'method', '--request': 'method', '-H': 'header', '--header': 'header', '-d': 'data', '--data': 'data', '--data-raw': 'data',
  '--data-binary': 'data', '--data-ascii': 'data', '--data-urlencode': 'urlencode', '--json': 'json', '-u': 'user', '--user': 'user',
  '-b': 'cookie', '--cookie': 'cookie', '-A': 'agent', '--user-agent': 'agent', '-e': 'referer', '--referer': 'referer', '--url': 'url',
  '-F': 'form', '--form': 'form', '-m': 'timeout', '--max-time': 'timeout',
};
const FLAGS: Record<string, string> = { '-L': 'location', '--location': 'location', '-k': 'insecure', '--insecure': 'insecure', '-G': 'get', '--get': 'get', '-I': 'head', '--head': 'head' };
/** tidak berpengaruh ke request: dilewati tanpa catatan */
const QUIET = new Set(['--compressed', '-s', '--silent', '-S', '--show-error', '-i', '--include', '-v', '--verbose', '-#', '--progress-bar', '-f', '--fail', '--globoff', '-g']);
const IGNORED_WITH_VALUE = new Set(['-o', '--output', '--cacert', '--cert', '--key', '-x', '--proxy', '--resolve', '--connect-timeout', '-w', '--write-out']);

export type CurlResult = { request: ParsedRequest; warnings: string[] };

/** perintah curl (bash) -> request http.me; opsi yang tidak diimpor dicatat di warnings (ditampilkan ke user) */
export function parseCurl(command: string): CurlResult {
  const args = tokenize(command.trim());
  if (!args.length || !/(^|\/)curl(\.exe)?$/i.test(args[0])) throw new Error('Not a curl command');
  const warnings: string[] = [];
  const headers: [string, string][] = [];
  const data: string[] = [];
  let method: string | undefined;
  let url: string | undefined;
  let json: string | undefined;
  let timeout: number | undefined;
  const flag = new Set<string>();
  const take = (opt: string, value: string | undefined) => {
    if (value === undefined) throw new Error(`Option ${opt} needs a value`);
    switch (VALUE[opt]) {
      case 'method': method = value.toUpperCase(); break;
      case 'header': { const c = value.indexOf(':'); if (c > 0) headers.push([value.slice(0, c).trim(), value.slice(c + 1).trim()]); break; }
      case 'data': data.push(value); break;
      case 'urlencode': { const eq = value.indexOf('='); data.push(eq < 0 ? encodeURIComponent(value) : `${value.slice(0, eq)}=${encodeURIComponent(value.slice(eq + 1))}`); break; }
      case 'json': json = (json ?? '') + value; break;
      case 'user': headers.push(['Authorization', `Basic ${value}`]); break;
      case 'cookie': if (value.includes('=')) headers.push(['Cookie', value]); else warnings.push(`Cookie file ${value} is not imported`); break;
      case 'agent': headers.push(['User-Agent', value]); break;
      case 'referer': headers.push(['Referer', value]); break;
      case 'url': url ??= value; break;
      case 'form': warnings.push(`Multipart (-F ${value}) is not imported yet`); break;
      case 'timeout': timeout = Math.ceil(Number(value)) || undefined; break;
    }
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a in VALUE) take(a, args[++i]);
    else if (a in FLAGS) flag.add(FLAGS[a]);
    else if (QUIET.has(a)) continue;
    else if (IGNORED_WITH_VALUE.has(a)) { warnings.push(`Ignored option ${a}`); i++; }
    else if (/^--[\w-]+=/.test(a) && a.slice(0, a.indexOf('=')) in VALUE) take(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
    else if (/^-[A-Za-z]/.test(a) && !a.startsWith('--') && a.length > 2) {
      // -XPOST / -HHeader (nilai menempel) atau -sSL (gabungan flag)
      const head = a.slice(0, 2);
      if (head in VALUE) take(head, a.slice(2));
      else if ([...a.slice(1)].every((ch) => `-${ch}` in FLAGS || QUIET.has(`-${ch}`))) [...a.slice(1)].forEach((ch) => FLAGS[`-${ch}`] && flag.add(FLAGS[`-${ch}`]));
      else warnings.push(`Unknown option ${a}`);
    } else if (a.startsWith('-')) warnings.push(a.startsWith('--') && !(a in VALUE) && /^--http/.test(a) ? `Ignored option ${a}` : `Unknown option ${a}`);
    else url ??= a;
  }
  if (!url) throw new Error('No URL in the curl command');

  const r = emptyRequest();
  const has = (name: string) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
  if (json !== undefined) {
    if (!has('Content-Type')) headers.push(['Content-Type', 'application/json']);
    if (!has('Accept')) headers.push(['Accept', 'application/json']);
    data.push(json);
  }
  let body = data.join('&');
  if (flag.has('get') && body) {
    url += (url.includes('?') ? '&' : '?') + body;
    body = '';
  } else if (data.length && json === undefined && !has('Content-Type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
  r.method = method ?? (flag.has('head') ? 'HEAD' : body ? 'POST' : 'GET');
  r.url = url;
  r.headers = headers.map(([name, value]) => ({ name, value, enabled: true }));
  r.body = body;
  r.bodyType = bodyTypeOf(headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1], body);
  r.followRedirects = flag.has('location');
  r.insecure = flag.has('insecure');
  r.timeoutSec = timeout;
  return { request: r, warnings };
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Copy as cURL: perintah bash multi-baris (header aktif, body bila method membawa body, -L / -k).
 * Cookie = setara password: header Cookie hanya ikut bila withCookies, digabung dengan cookie jar (nama di request menang).
 */
export function toCurl(r: ParsedRequest, opts: { withCookies?: boolean; jar?: string } = {}): string {
  const first = `curl${r.method === 'GET' ? '' : ` -X ${r.method}`} ${quote(r.url)}`;
  const isCookie = (name: string) => name.toLowerCase() === 'cookie';
  const rest = r.headers.filter((h) => h.enabled && h.name && !isCookie(h.name)).map((h) => `-H ${quote(`${h.name}: ${h.value}`)}`);
  if (opts.withCookies) {
    const own = r.headers.filter((h) => h.enabled && isCookie(h.name)).flatMap((h) => h.value.split(';').map((p) => p.trim()).filter(Boolean));
    const names = new Set(own.map((p) => p.split('=')[0]));
    const all = [...own, ...(opts.jar ?? '').split(';').map((p) => p.trim()).filter((p) => p && !names.has(p.split('=')[0]))];
    if (all.length) rest.push(`-b ${quote(all.join('; '))}`);
  }
  if (sendsBody(r.method)) {
    if (r.bodyFile) rest.push(`--data-binary ${quote(`@${r.bodyFile}`)}`);
    else if (r.body !== '') rest.push(`--data-raw ${quote(r.body)}`);
  }
  if (r.followRedirects) rest.push('-L');
  if (r.insecure) rest.push('-k');
  if (r.timeoutSec !== undefined) rest.push(`--max-time ${r.timeoutSec}`);
  return [first, ...rest].join(' \\\n  ');
}

/** header yang hanya dikirim browser: ikut diimpor tapi dimatikan (# @disabled) */
const BROWSER_HEADER = /^(sec-ch-ua(-.*)?|sec-fetch-.*|sec-gpc|dnt|priority|upgrade-insecure-requests|user-agent|accept-language|accept-encoding|referer|origin|cache-control|pragma)$/i;

/** paste / Import from Clipboard: parseCurl + header browser dimatikan + ringkasan satu kalimat untuk notifikasi */
export function importCurl(command: string): CurlResult & { summary: string; /** isi header Cookie / -b (ditawarkan disimpan ke cookie jar) */ cookies?: string } {
  const res = parseCurl(command);
  res.request.followRedirects = true; // perintah dari browser tidak pernah memakai -L, padahal browser mengikuti redirect
  let off = 0;
  for (const h of res.request.headers) if (BROWSER_HEADER.test(h.name)) { h.enabled = false; off++; }
  let where = res.request.url;
  try { where = new URL(res.request.url).pathname; } catch { /* URL berisi {{var}}: ditampilkan apa adanya */ }
  const parts = [off ? `${off} browser header${off === 1 ? '' : 's'} disabled` : ''].filter(Boolean);
  const summary = `Imported ${res.request.method} ${where}${parts.length ? `: ${parts.join(', ')}.` : '.'}${res.warnings.length ? ` ${res.warnings.join('; ')}` : ''}`;
  const cookies = res.request.headers.find((h) => h.name.toLowerCase() === 'cookie')?.value;
  return { ...res, summary, ...(cookies ? { cookies } : {}) };
}
