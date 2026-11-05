// server loopback untuk redirect OAuth 2.0 (tanpa vscode): menangkap ?code=… / #access_token=… dari browser
import * as http from 'node:http';

export type Loopback = { redirectUri: string; /** URL redirect lengkap setelah browser kembali (query atau fragment) */ wait(signal: AbortSignal): Promise<string>; close(): void };

const PAGE = (body: string) => `<!doctype html><meta charset="utf-8"><title>http.me</title><body style="font-family:sans-serif;padding:2rem">${body}`;
// fragment (#…) tidak dikirim ke server: halaman ini meneruskannya sebagai query ke /__fragment
const FRAGMENT_PAGE = PAGE('<p>Completing sign-in…</p><script>fetch("/__fragment?"+location.hash.slice(1)).then(()=>{document.body.innerHTML="<p>You can close this tab and return to VS Code.</p>"})</script>');

/** `redirectUri` kosong = 127.0.0.1 port acak, /callback; atau http://localhost|127.0.0.1:port/path milik pengguna (port 0 = acak). Selain itu ditolak */
export async function loopback(redirectUri: string | undefined, timeoutMs = 180_000): Promise<Loopback> {
  let host = '127.0.0.1', port = 0, path = '/callback';
  if (redirectUri) {
    const u = new URL(redirectUri);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('Redirect URI must be an http://localhost or http://127.0.0.1 loopback address to be caught by http.me');
    host = u.hostname; port = Number(u.port || 80); path = u.pathname;
  }
  let done!: (url: string) => void;
  const result = new Promise<string>((resolve) => { done = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const reply = (html: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    if (url.pathname === '/__fragment') { reply(''); done(`${base}#${url.searchParams.toString()}`); return; }
    if (url.pathname !== path) { res.writeHead(404).end(); return; }
    if (url.search) { reply(PAGE('<p>You can close this tab and return to VS Code.</p>')); done(`${base}${url.search}`); } else reply(FRAGMENT_PAGE);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const base = `http://${host}:${(server.address() as { port: number }).port}${path}`;
  const close = () => { server.close(); server.closeAllConnections(); };
  return {
    redirectUri: base,
    close,
    wait: (signal) => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OAuth 2.0 sign-in timed out')), timeoutMs);
      const abort = () => reject(new Error('OAuth 2.0 sign-in cancelled'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      result.then(resolve, reject).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
    }),
  };
}
