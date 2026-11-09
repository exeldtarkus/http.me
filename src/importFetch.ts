// Import dari URL: auth dari `_auth.http` workspace + filter file drag & drop (tanpa vscode)
import { applyAuth, parseAuth } from './auth';
import { parseRequest } from './httpFile';

/** URL + header untuk fetch spec; authText = isi `_auth.http` (undefined = tanpa auth). values = nilai {{variable}} yang sudah diselesaikan */
export function importAuth(url: string, authText: string | undefined, values: ReadonlyMap<string, string>): { url: string; headers: [string, string][] } {
  if (authText === undefined) return { url, headers: [] };
  const r = parseRequest(authText);
  const cfg = parseAuth(r.auth, r.headers);
  if (cfg.type === 'oauth2' || cfg.type === 'digest') throw new Error(`Import from URL does not support ${cfg.type === 'oauth2' ? 'OAuth 2.0' : 'Digest'} auth: download the file and import it from disk`);
  const out = applyAuth({ method: 'GET', url, headers: [] }, cfg, values);
  return { url: out.request.url, headers: out.request.headers };
}

const IMPORTABLE = /\.(json|ya?ml)$/i;
/** hasil drop dari luar: hanya spec / collection (file .http dipindahkan, bukan diimpor) */
export const importableFiles = (uris: readonly string[]): string[] => uris.filter((u) => IMPORTABLE.test(u));

/** URL halaman Swagger UI (`…/swagger-ui/index.html`, `swagger-ui.html`) → kandidat URL spec yang dicoba berurutan; undefined = bukan halaman Swagger UI */
export function specUrlCandidates(raw: string): string[] | undefined {
  let u: URL;
  try { u = new URL(raw); } catch { return undefined; } // bukan URL absolut: dipakai apa adanya
  const m = /^(.*?)\/swagger-ui(?:\/index\.html|\.html|\/)?$/i.exec(u.pathname);
  if (!m) return undefined;
  const base = `${u.origin}${m[1]}`;
  const explicit = u.searchParams.get('url');
  return [...(explicit ? [new URL(explicit, `${base}/`).toString().replace(/^(https?:\/\/[^/]+)\/\/+/, '$1/')] : []),
    ...['/v3/api-docs', '/v2/api-docs', '/openapi.json', '/swagger/v1/swagger.json', '/swagger.json', '/v3/api-docs.yaml'].map((p) => `${base}${p}`)];
}
