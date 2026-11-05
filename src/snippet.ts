// panel Code snippet (tanpa vscode): request -> cURL / cURL (cmd) / PowerShell sesuai opsi, plus masking secret
import { toCurl } from './curl';
import { toCurlCmd, toPowerShell } from './shellDialect';
import type { ParsedRequest } from './httpFile';

export type SnippetLanguage = 'curl' | 'cmd' | 'powershell';
export type SnippetOptions = {
  language: SnippetLanguage;
  /** --header / --request ... bukan -H / -X */ longForm: boolean;
  /** isi {{variable}} dengan nilainya (diatur pemanggil sebelum generate; secret di-mask lewat maskSecrets) */ resolve: boolean;
  /** ikuti redirect (-L / tanpa -MaximumRedirection 0) */ followRedirects: boolean;
  /** sertakan header Cookie + cookie jar */ cookies: boolean;
  /** sertakan header yang dimatikan (# @disabled) */ disabledHeaders: boolean;
  /** satu opsi per baris disambung \ ^ ` */ multiLine: boolean;
};

export const DEFAULT_SNIPPET: SnippetOptions = { language: 'curl', longForm: false, resolve: true, followRedirects: true, cookies: false, disabledHeaders: false, multiLine: true };

export function generateSnippet(r: ParsedRequest, o: SnippetOptions, extra: { jar?: string } = {}): string {
  const prepared: ParsedRequest = { ...r, followRedirects: o.followRedirects, headers: r.headers.map((h) => ({ ...h, enabled: h.enabled || o.disabledHeaders })) };
  const render = o.language === 'cmd' ? toCurlCmd : o.language === 'powershell' ? toPowerShell : toCurl;
  return render(prepared, { withCookies: o.cookies, jar: extra.jar, longForm: o.longForm, multiLine: o.multiLine });
}

/** nilai secret -> ********, yang terpanjang dulu supaya secret yang memuat secret lain tidak terpotong */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  return [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length).reduce((t, s) => t.split(s).join('********'), text);
}

export const usesSecrets = (text: string, secrets: readonly string[]): boolean => secrets.some((s) => s !== '' && text.includes(s));
