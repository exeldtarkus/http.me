// format log error (tanpa vscode): konteks + pesan + stack trace dalam satu entri, secret di-mask

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const errStack = (e: unknown): string => (e instanceof Error ? e.stack ?? e.message : String(e));

/** header / parameter yang nilainya tidak boleh masuk log */
export function maskSecrets(s: string): string {
  return s
    .replace(/^(\s*(?:proxy-)?authorization|\s*cookie|\s*set-cookie)(\s*:\s*)\S.*$/gim, '$1$2***')
    .replace(/\bBearer\s+[^\s"']+/g, 'Bearer ***')
    .replace(/([?&;](?:password|passwd|pwd|token|access_token|refresh_token|client_secret|secret|api[_-]?key)=)[^&#\s]*/gi, '$1***');
}

/** `<konteks> - EXCEPTION CAUGHT | <pesan> - stack-trace: <stack>` untuk output channel "http.me" */
export const errorLine = (where: string, e: unknown): string =>
  maskSecrets(`${where} - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);

/** nilai Secret Environment / Globals tidak boleh masuk log / history */
export const maskValues = (s: string, values: readonly string[]): string =>
  [...values].filter(Boolean).sort((a, b) => b.length - a.length).reduce((acc, v) => acc.split(v).join('***'), s);
