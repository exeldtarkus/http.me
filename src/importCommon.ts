// bagian bersama import Postman / OpenAPI / JetBrains (tanpa vscode): rencana file, deteksi format, nama aman, baris auth
export type ImportFile = { /** relatif ke folder tujuan, pemisah `/` */ path: string; content: string; warnings: string[]; /** operationId asal OpenAPI (sinkron ulang) */ operation?: string };
export type ImportPlan = {
  name: string; format: 'postman' | 'openapi'; files: ImportFile[]; warnings: string[];
  /** variable Environment yang dibutuhkan (mis. `<NAMA>_BASE_URL`): Environment aktif terisi, lainnya NULL */
  environmentVars?: { key: string; value: string }[];
};

export type FormatName = 'postman-collection' | 'postman-environment' | 'postman-globals' | 'openapi' | 'swagger' | 'jetbrains-env' | 'curl';
export type Detected = { format: FormatName; /** isi terparse (kecuali curl) */ data?: Record<string, unknown> };

const ILLEGAL = /[<>:"|?*\\/\u0000-\u001f]/g; // karakter yang ditolak Windows + pemisah path
/** nama file / folder aman dari teks bebas */
export const safeName = (s: string, fallback = 'request'): string => s.replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || fallback;

/** nama unik per folder: `a.http`, `a 2.http`, ... (tanpa huruf besar/kecil: Windows) */
export function uniqueNamer(): (dir: string, base: string, ext: string) => string {
  const seen = new Set<string>();
  return (dir, base, ext) => {
    for (let n = 1; ; n++) {
      const path = `${dir ? `${dir}/` : ''}${base}${n === 1 ? '' : ` ${n}`}${ext}`;
      if (!seen.has(path.toLowerCase())) { seen.add(path.toLowerCase()); return path; }
    }
  };
}

/** nilai field `# @auth` : polos bila aman, selain itu dikutip */
const authValue = (v: string) => (/^[^\s"'\\]+$/.test(v) ? v : `"${v.replace(/[\\"]/g, '\\$&')}"`);
export const authText = (type: string, fields: Readonly<Record<string, string>>): string =>
  [type, ...Object.entries(fields).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${authValue(v)}`)].join(' ');

/** JSON (parser bawaan) atau YAML (library `yaml`, di-require lazy hanya saat teks bukan JSON) */
export function parseDoc(text: string): unknown {
  const t = text.replace(/^\uFEFF/, '');
  if (/^\s*[[{]/.test(t)) return JSON.parse(t);
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: YAML jarang dipakai, modul tidak dimuat sebelum perlu
  return (require('yaml') as typeof import('yaml')).parse(t);
}

/** serialize untuk export (Fase 5c) dan uji round-trip: JSON bawaan, YAML lewat library `yaml` (lazy) */
export function stringifyDoc(doc: unknown, format: 'json' | 'yaml'): string {
  if (format === 'json') return `${JSON.stringify(doc, null, 2)}\n`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, lihat parseDoc
  return (require('yaml') as typeof import('yaml')).stringify(doc);
}

const NOT_SUPPORTED = 'The content is not a supported format (expected a Postman collection / environment, an OpenAPI / Swagger spec, a JetBrains http-client.env.json, or a cURL command)';

/** deteksi otomatis dari isi; melempar pesan siap tampil bila tidak dikenal / Collection v1 */
export function detectFormat(text: string): Detected {
  const t = text.trim();
  if (/^curl(\.exe)?\s/i.test(t)) return { format: 'curl' };
  let data: unknown;
  try { data = parseDoc(t); } catch { throw new Error(NOT_SUPPORTED); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(NOT_SUPPORTED);
  const d = data as Record<string, unknown>;
  const info = d.info as { schema?: unknown } | undefined;
  if (typeof info?.schema === 'string' && info.schema.includes('getpostman.com/json/collection')) return { format: 'postman-collection', data: d };
  if (Array.isArray(d.order) && Array.isArray(d.requests)) throw new Error('Postman Collection v1 is not supported. Re-export as Collection v2.1 from Postman.');
  if (Array.isArray(d.values) && typeof d.name === 'string') return { format: d._postman_variable_scope === 'globals' ? 'postman-globals' : 'postman-environment', data: d };
  if (typeof d.swagger === 'string') return { format: 'swagger', data: d };
  if (typeof d.openapi === 'string') return { format: 'openapi', data: d };
  const vals = Object.values(d);
  if (vals.length && vals.every((v) => v && typeof v === 'object' && !Array.isArray(v))) return { format: 'jetbrains-env', data: d };
  throw new Error(NOT_SUPPORTED);
}
