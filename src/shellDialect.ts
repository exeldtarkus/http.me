// dialek shell selain bash (tanpa vscode): cmd (^), PowerShell (`), Invoke-WebRequest -> argumen gaya curl, dan ekspor ke cmd / PowerShell
import type { ParsedRequest } from './httpFile';
import { sendsBody } from './http';
import { parseAuth } from './auth';

const unclosed = () => new Error('Unclosed quote in the command');

/** cmd: ^ meloloskan karakter berikutnya (di luar "…"), ^ + baris baru = sambung; sisanya diurai seperti argv Windows (\" = kutip literal) */
export function tokenizeCmd(src: string): string[] {
  let flat = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '^' && !quoted) {
      if (src[i + 1] === '\r' && src[i + 2] === '\n') i += 2;
      else if (src[i + 1] === '\n') i += 1;
      else if (i + 1 < src.length) flat += src[++i]; // " hasil ^" tidak mengubah status kutip cmd, tapi tetap membuka / menutup kutip argv
      continue;
    }
    if (c === '"') quoted = !quoted;
    flat += c;
  }
  // argv Windows: 2n\ + " = n\ lalu toggle kutip, 2n+1\ + " = n\ lalu kutip literal
  const out: string[] = [];
  let cur = '';
  let has = false;
  let inQ = false;
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i];
    if (c === '\\') {
      let n = 0;
      while (flat[i] === '\\') { n++; i++; }
      if (flat[i] === '"') { cur += '\\'.repeat(n >> 1); if (n & 1) cur += '"'; else inQ = !inQ; has = true; } else { cur += '\\'.repeat(n); i--; has = true; }
      continue;
    }
    if (c === '"') { inQ = !inQ; has = true; continue; }
    if (!inQ && /\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c;
    has = true;
  }
  if (inQ) throw unclosed();
  if (has) out.push(cur);
  return out;
}

const PS_ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };

/** PowerShell: '…' literal ('' = '), "…" dengan `x dan "" = ", ` di luar kutip = escape, ` + baris baru = sambung */
export function tokenizePs(src: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '`') {
      if (src[i + 1] === '\r' && src[i + 2] === '\n') { i += 3; continue; }
      if (src[i + 1] === '\n') { i += 2; continue; }
      cur += src[i + 1] ?? '';
      has = true;
      i += 2;
    } else if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } i++; } else if (c === "'") {
      has = true;
      for (i++; ; i++) {
        if (i >= src.length) throw unclosed();
        if (src[i] === "'") { if (src[i + 1] === "'") { cur += "'"; i++; continue; } i++; break; }
        cur += src[i];
      }
    } else if (c === '"') {
      has = true;
      for (i++; ; i++) {
        if (i >= src.length) throw unclosed();
        if (src[i] === '"') { if (src[i + 1] === '"') { cur += '"'; i++; continue; } i++; break; }
        if (src[i] === '`') { i++; cur += PS_ESC[src[i]] ?? src[i] ?? ''; continue; }
        cur += src[i];
      }
    } else { cur += c; has = true; i++; }
  }
  if (has) out.push(cur);
  return out;
}

const PS_CMDLET = /^\s*(?:\$\w[^\n]*\n\s*)*(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;
export const isPowerShellRequest = (text: string): boolean => PS_CMDLET.test(text);
/** cmd: ^ di awal kata kutip atau di akhir baris (^ di dalam '…' bash tidak dihitung) */
export const isCmdCommand = (text: string): boolean => /(^|\s)\^"|\^\r?\n/.test(text);
/** curl.exe dari PowerShell: sambungan baris dengan backtick */
export const isPsCurl = (text: string): boolean => /`\r?\n/.test(text);

/** isi hashtable `@{ "k"="v"; k2='v2' }` mulai di `at` (posisi '@'): [pasangan, indeks setelah '}'] */
function hashtable(src: string, at: number): { pairs: [string, string][]; end: number } {
  const pairs: [string, string][] = [];
  let i = at + 2;
  const str = (): string => {
    const q = src[i];
    if (q !== '"' && q !== "'") { const m = /^[^\s=;}]+/.exec(src.slice(i)); i += m?.[0].length ?? 0; return m?.[0] ?? ''; }
    const start = i;
    for (i++; i < src.length; i++) {
      if (q === '"' && src[i] === '`') { i++; continue; }
      if (src[i] === q) { if (src[i + 1] === q) { i++; continue; } break; }
    }
    if (i >= src.length) throw unclosed();
    i++;
    return tokenizePs(src.slice(start, i))[0] ?? '';
  };
  for (;;) {
    while (i < src.length && /[\s;]/.test(src[i])) i++;
    if (i >= src.length) throw new Error('Unclosed @{ in the PowerShell command');
    if (src[i] === '}') return { pairs, end: i + 1 };
    const k = str();
    while (/\s/.test(src[i] ?? '')) i++;
    if (src[i] !== '=') throw new Error(`Expected = after header ${k}`);
    i++;
    while (/\s/.test(src[i] ?? '')) i++;
    pairs.push([k, str()]);
  }
}

const PS_SWITCH = new Set(['usebasicparsing', 'skipcertificatecheck', 'skiphttperrorcheck', 'allowunencryptedauthentication', 'disablekeepalive', 'passthru', 'noproxy', 'skipheadervalidation', 'resume', 'allowinsecureredirect']);

/** Invoke-WebRequest / Invoke-RestMethod (+ $session UserAgent & Cookies) -> argumen gaya curl untuk parser yang sama */
export function psToArgs(text: string): { args: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const cookies: string[] = [];
  let ua: string | undefined;
  let src = '';
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\$/.test(line)) { src += `${line}\n`; continue; }
    const u = /^\s*\$\w+\.UserAgent\s*=\s*(["'].*["'])\s*$/.exec(line);
    if (u) ua = tokenizePs(u[1])[0];
    const c = /System\.Net\.Cookie\(\s*("(?:`.|[^"`])*"|'(?:''|[^'])*')\s*,\s*("(?:`.|[^"`])*"|'(?:''|[^'])*')/.exec(line);
    if (c) cookies.push(`${tokenizePs(c[1])[0]}=${tokenizePs(c[2])[0]}`);
  }
  const headers: [string, string][] = [];
  const at = src.search(/-Headers\s+@\{/i);
  if (at >= 0) {
    const h = hashtable(src, src.indexOf('@{', at));
    headers.push(...h.pairs);
    src = `${src.slice(0, at)}-Headers __x__ ${src.slice(h.end)}`;
  }
  const t = tokenizePs(src);
  const args = ['curl'];
  let url: string | undefined, method: string | undefined, body: string | undefined, type: string | undefined, timeout: string | undefined;
  let follow = true, insecure = false;
  for (let i = 1; i < t.length; i++) {
    const a = t[i];
    const m = /^-([A-Za-z]+)(?::(.*))?$/.exec(a);
    if (!m) { url ??= a; continue; }
    const name = m[1].toLowerCase();
    if (PS_SWITCH.has(name)) { if (name === 'skipcertificatecheck') insecure = true; continue; }
    const value = m[2] ?? t[++i];
    switch (name) {
      case 'uri': url = value; break;
      case 'method': method = value?.toUpperCase(); break;
      case 'body': body = value; break;
      case 'contenttype': type = value; break;
      case 'useragent': ua = value; break;
      case 'timeoutsec': timeout = value; break;
      case 'maximumredirection': if (Number(value) === 0) follow = false; break;
      case 'headers': case 'websession': break;
      default: warnings.push(`Ignored option -${m[1]}`);
    }
  }
  if (!url) throw new Error('No URL in the PowerShell command');
  if (method) args.push('-X', method);
  for (const [k, v] of headers) args.push('-H', `${k}: ${v}`);
  if (type && !headers.some(([k]) => k.toLowerCase() === 'content-type')) args.push('-H', `Content-Type: ${type}`);
  if (ua && !headers.some(([k]) => k.toLowerCase() === 'user-agent')) args.push('-H', `User-Agent: ${ua}`);
  if (cookies.length && !headers.some(([k]) => k.toLowerCase() === 'cookie')) args.push('-H', `Cookie: ${cookies.join('; ')}`);
  if (body !== undefined) args.push('--data-raw', body);
  if (follow) args.push('-L');
  if (insecure) args.push('-k');
  if (timeout) args.push('--max-time', timeout);
  args.push(url);
  return { args, warnings };
}

// ---- ekspor ----

const isCookie = (name: string) => name.toLowerCase() === 'cookie';
/** pasangan name=value cookie: header Cookie request + jar (nama di request menang); kosong bila !withCookies */
export function cookiePairs(r: ParsedRequest, opts: { withCookies?: boolean; jar?: string }): string[] {
  if (!opts.withCookies) return [];
  const own = r.headers.filter((h) => h.enabled && isCookie(h.name)).flatMap((h) => h.value.split(';').map((p) => p.trim()).filter(Boolean));
  const names = new Set(own.map((p) => p.split('=')[0]));
  return [...own, ...(opts.jar ?? '').split(';').map((p) => p.trim()).filter((p) => p && !names.has(p.split('=')[0]))];
}

export type ExportOpts = { withCookies?: boolean; jar?: string; /** --header / --request / ... bukan -H / -X */ longForm?: boolean; /** false = satu baris tanpa sambungan */ multiLine?: boolean };
/** nama opsi curl: pendek atau panjang */
export const curlFlags = (longForm?: boolean) => longForm
  ? { X: '--request', H: '--header', b: '--cookie', L: '--location', k: '--insecure' } as const
  : { X: '-X', H: '-H', b: '-b', L: '-L', k: '-k' } as const;
const activeHeaders = (r: ParsedRequest) => r.headers.filter((h) => h.enabled && h.name && !isCookie(h.name));

/** string cmd gaya Chrome: ^"…^"; \" untuk kutip, ^ di depan karakter spesial cmd, baris baru = ^<LF><LF> */
const cmdQuote = (s: string): string =>
  `^"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/[\^&|<>()%!"]/g, '^$&').replace(/\r?\n/g, '^\n\n')}^"`;

/** Copy as cURL (cmd): satu baris per opsi, disambung dengan ^ */
export function toCurlCmd(r: ParsedRequest, opts: ExportOpts = {}): string {
  const f = curlFlags(opts.longForm);
  const lines = [`curl${r.method === 'GET' ? '' : ` ${f.X} ${r.method}`} ${cmdQuote(r.url)}`];
  const auth = curlAuthOptions(r, opts.longForm);
  for (const h of activeHeaders(r)) if (!auth?.drop.includes(h.name.toLowerCase())) lines.push(`${f.H} ${cmdQuote(`${h.name}: ${h.value}`)}`);
  for (const [flag, value] of auth?.options ?? []) lines.push(value === undefined ? flag : `${flag} ${cmdQuote(value)}`);
  const cookies = cookiePairs(r, opts);
  if (cookies.length) lines.push(`${f.b} ${cmdQuote(cookies.join('; '))}`);
  if (sendsBody(r.method)) {
    if (r.bodyFile) lines.push(`--data-binary ${cmdQuote(`@${r.bodyFile}`)}`);
    else if (r.body !== '') lines.push(`--data-raw ${cmdQuote(r.body)}`);
  }
  if (r.followRedirects) lines.push(f.L);
  if (r.insecure) lines.push(f.k);
  if (r.timeoutSec !== undefined) lines.push(`--max-time ${r.timeoutSec}`);
  return lines.join(opts.multiLine === false ? ' ' : ' ^\n  ');
}

const psQuote = (s: string): string => `"${s.replace(/[`"$]/g, '`$&').replace(/\r/g, '`r').replace(/\n/g, '`n')}"`;

/** Copy as PowerShell: Invoke-WebRequest gaya Chrome (-Headers @{…}, -ContentType, -Body, $session untuk cookie) */
export function toPowerShell(r: ParsedRequest, opts: ExportOpts = {}): string {
  const head: string[] = [];
  const cookies = cookiePairs(r, opts);
  if (cookies.length) {
    let host = '';
    try { host = new URL(r.url).hostname; } catch { host = ''; } // URL berisi {{var}}: domain cookie dikosongkan
    head.push('$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession',
      ...cookies.map((c) => `$session.Cookies.Add((New-Object System.Net.Cookie(${psQuote(c.slice(0, c.indexOf('=')))}, ${psQuote(c.slice(c.indexOf('=') + 1))}, "/", ${psQuote(host)})))`));
  }
  const basic = curlAuthOptions(r)?.options.find(([o]) => o === '-u')?.[1];
  const all = activeHeaders(r).map((h) => (basic !== undefined && h.name.toLowerCase() === 'authorization' && !basic.includes('{{') ? { ...h, value: `Basic ${Buffer.from(basic).toString('base64')}` } : h));
  const type = all.find((h) => h.name.toLowerCase() === 'content-type');
  const rest = all.filter((h) => h !== type);
  const parts = [`Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(r.url)}`];
  if (r.method !== 'GET') parts.push(`-Method ${psQuote(r.method)}`);
  if (cookies.length) parts.push('-WebSession $session');
  const multi = opts.multiLine !== false;
  if (rest.length) parts.push(multi ? `-Headers @{\n${rest.map((h) => `${psQuote(h.name)}=${psQuote(h.value)}`).join('\n')}\n}` : `-Headers @{ ${rest.map((h) => `${psQuote(h.name)}=${psQuote(h.value)}`).join('; ')} }`);
  if (type) parts.push(`-ContentType ${psQuote(type.value)}`);
  if (sendsBody(r.method) && !r.bodyFile && r.body !== '') parts.push(`-Body ${psQuote(r.body)}`);
  if (r.bodyFile && sendsBody(r.method)) parts.push(`-InFile ${psQuote(r.bodyFile)}`);
  if (!r.followRedirects) parts.push('-MaximumRedirection 0');
  if (r.insecure) parts.push('-SkipCertificateCheck');
  if (r.timeoutSec !== undefined) parts.push(`-TimeoutSec ${r.timeoutSec}`);
  return [...head, parts.join(multi ? ' `\n' : ' ')].join('\n');
}

/** auth yang punya opsi cURL asli: header Authorization diganti -u / --digest / --aws-sigv4 (nilai belum di-quote; pemanggil yang quote) */
export function curlAuthOptions(r: ParsedRequest, longForm?: boolean): { drop: string[]; options: [string, string?][] } | undefined {
  let a;
  try { a = parseAuth(r.auth, r.headers); } catch { return undefined; } // skema tak dikenal / auth rusak: header tetap diekspor apa adanya
  const user = longForm ? '--user' : '-u';
  if (a.type === 'basic') return { drop: ['authorization'], options: [[user, `${a.fields.username}:${a.fields.password}`]] };
  if (a.type === 'digest') return { drop: ['authorization'], options: [['--digest'], [user, `${a.fields.username}:${a.fields.password}`]] };
  if (a.type === 'aws') return { drop: ['authorization'], options: [['--aws-sigv4', `aws:amz:${a.fields.region}:${a.fields.service}`], ['--user', `${a.fields.access_key}:${a.fields.secret_key}`]] };
  return undefined;
}
