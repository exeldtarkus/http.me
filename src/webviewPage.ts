import { readFileSync } from 'fs';
import { join } from 'path';

const cache = new Map<string, string>();
const read = (file: string) => readFileSync(join(__dirname, '..', '..', 'media', 'webview', file), 'utf8');

/**
 * halaman webview dari media/webview/<name>.html; {{key}} diganti vars[key] apa adanya (escape dilakukan pemanggil).
 * __dirname = out/src/ (hasil tsc), jadi media/ ada di ../../media.
 */
export function webviewPage(name: string, vars: Record<string, string | number>): string {
  let tpl = cache.get(name);
  if (tpl === undefined) {
    // <script nonce="{{nonce}}" src="x.js"></script> -> isi x.js di-inline (webview butuh nonce, screenshot/test tanpa URI webview)
    tpl = read(`${name}.html`)
      // <!--include:x--> diganti isi media/webview/x.html (potongan bersama, mis. bar Back to Dashboard)
      .replace(/<!--include:([\w-]+)-->/g, (_m, part: string) => read(`${part}.html`))
      .replace(/<script nonce="\{\{nonce\}\}" src="([\w.-]+\.js)"><\/script>/g,
      (_m, file: string) => `<script nonce="{{nonce}}">\n${read(file)}</script>`);
    cache.set(name, tpl);
  }
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    if (!(key in vars)) throw new Error(`webview ${name}: placeholder {{${key}}} tidak diisi`);
    return String(vars[key]);
  });
}

/** JSON untuk blok <script type="application/json" id="page-data">: '<' di-escape supaya '</script>' di data tidak menutup blok */
export const pageJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

/** escape teks untuk HTML webview */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
