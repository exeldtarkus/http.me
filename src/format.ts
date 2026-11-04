// versi format file JSON milik http.me (.httpme/environments/*.json, _variables.json, _source.json), tanpa vscode
export const HTTPME_FORMAT = 1;

/** JSON siap tulis dengan "httpmeFormat" paling atas */
export function stringifyFormatted(data: object): string {
  const { httpmeFormat: _old, ...rest } = data as { httpmeFormat?: unknown };
  return `${JSON.stringify({ httpmeFormat: HTTPME_FORMAT, ...rest }, null, 2)}\n`;
}

/** baca file JSON http.me; tanpa "httpmeFormat" = format 1, format lebih baru ditolak (pesan tampil ke user) */
export function parseFormatted<T extends object = Record<string, unknown>>(text: string, fileName: string): T {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${fileName}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${fileName}: expected a JSON object`);
  const v = (data as { httpmeFormat?: unknown }).httpmeFormat;
  if (v === undefined) return data as T;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${fileName}: invalid "httpmeFormat" ${JSON.stringify(v)}`);
  if (v > HTTPME_FORMAT) throw new Error(`${fileName} was saved by a newer version of http.me (format ${v}). Update http.me to open it.`);
  return data as T;
}
