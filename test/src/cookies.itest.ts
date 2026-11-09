import * as assert from 'node:assert/strict';
import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ITests } from './it/index';
import { startServer } from './helpers/server';

type Cookie = { name: string; value: string; domain: string; path: string };
type Node = { kind: string; env?: string; domain?: string; cookie?: Cookie };
type Api = {
  sidebar: { mode: string; getChildren(n?: Node): Promise<Node[]>; getTreeItem(n: Node): Promise<vscode.TreeItem> };
  cookies: { dir: string; env: string; jar(env: string): Promise<Cookie[]>; setJar(env: string, jar: Cookie[]): Promise<void>; loginRequest(): string | undefined; setLoginRequest(uri: string | undefined): Promise<void> };
  viewOf(key: string): { kind: string; status?: string; note?: string; cookies?: { name: string }[]; timeline?: { status: number }[] } | undefined;
};
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const cmd = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(id, ...args);
async function until<T>(fn: () => T | Promise<T>, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await wait(50);
  }
}

/** tiruan BIMA: POST /login (form) -> 302 /home + Set-Cookie JSESSIONID; tanpa cookie valid semua halaman 302 /login */
async function bima() {
  let session = '';
  let logins = 0;
  const seen: string[] = [];
  const srv = await startServer(async (req, body) => {
    const sid = /JSESSIONID=(\w+)/.exec(String(req.headers.cookie ?? ''))?.[1];
    seen.push(`${req.method} ${req.url} ${sid ?? '-'}`);
    if (req.url === '/login' && req.method === 'POST') {
      if (body !== 'username=u&password=p') return { status: 200, body: 'bad login' };
      session = `S${++logins}`;
      return { status: 302, headers: { location: '/home', 'set-cookie': [`JSESSIONID=${session}; Path=/; HttpOnly`] } };
    }
    if (req.url === '/login') return { status: 200, headers: { 'content-type': 'text/html' }, body: '<form>login</form>' };
    if (!sid || sid !== session) return { status: 302, headers: { location: '/login' } };
    return { status: 200, body: `home ${sid}` };
  });
  return { srv, seen, logins: () => logins, expire: () => { session = 'gone'; } };
}

export const tests: ITests = {
  async 'Sidebar Cookies: Environment → domain → cookie (nilai di-mask), paste dari browser, tambah / edit / hapus, hapus per domain / semua; chunk 0600'() {
    try {
      await cmd('httpme.showCookies');
      assert.equal(api().sidebar.mode, 'cookies');
      await cmd('httpme.clearCookies', undefined, true);
      assert.deepEqual((await api().sidebar.getChildren()).map((n) => n.kind), ['cenv', 'cempty']);
      await cmd('httpme.pasteCookies', undefined, 'bima.test', 'Cookie: JSESSIONID=ABCDEF123; theme=dark');
      await cmd('httpme.addCookie', undefined, 'other.test', 'k=v1234567');
      const [envNode] = await api().sidebar.getChildren();
      assert.equal((await api().sidebar.getTreeItem(envNode)).description, 'active · 3 cookies');
      const domains = await api().sidebar.getChildren(envNode);
      assert.deepEqual(domains.map((d) => d.domain), ['bima.test', 'other.test']);
      const list = await api().sidebar.getChildren(domains[0]);
      assert.deepEqual(list.map((c) => c.cookie!.name), ['JSESSIONID', 'theme']);
      const item = await api().sidebar.getTreeItem(list[0]);
      assert.equal(item.description, 'ABCD… · session');
      assert.ok(!String(item.tooltip).includes('ABCDEF123'), 'nilai tidak tampil di tooltip');
      const files = readdirSync(api().cookies.dir).filter((f) => f.endsWith('.json'));
      assert.deepEqual(files.sort(), ['%7Cbima.test.json', '%7Cother.test.json']);
      assert.equal(statSync(join(api().cookies.dir, files[0])).mode & 0o777, 0o600);

      await cmd('httpme.editCookie', list[1], 'light');
      assert.equal((await api().cookies.jar('')).find((c) => c.name === 'theme')!.value, 'light');
      const edited = (await api().sidebar.getChildren(domains[0]))[1]; // tree diambil ulang seperti di UI
      await cmd('httpme.copyCookieValue', edited);
      assert.equal(await vscode.env.clipboard.readText(), 'light');
      await cmd('httpme.copyCookie', edited);
      assert.equal(await vscode.env.clipboard.readText(), 'theme=light');
      await cmd('httpme.renameCookie', edited, 'mode');
      assert.deepEqual((await api().cookies.jar('')).filter((c) => c.domain === 'bima.test').map((c) => `${c.name}=${c.value}`).sort(), ['JSESSIONID=ABCDEF123', 'mode=light']);
      await cmd('httpme.deleteCookie', (await api().sidebar.getChildren(domains[0]))[1], true);
      await cmd('httpme.deleteCookieDomain', domains[1], true);
      assert.deepEqual((await api().cookies.jar('')).map((c) => c.name), ['JSESSIONID']);
      await cmd('httpme.pasteCookies', { kind: 'cenv', env: 'dev' }, 'bima.test', 'JSESSIONID=DEV1');
      assert.deepEqual((await api().cookies.jar('dev')).map((c) => c.value), ['DEV1'], 'jar per Environment terpisah');
      assert.equal((await api().cookies.jar(''))[0].value, 'ABCDEF123');
      await cmd('httpme.clearCookies', undefined, true);
      assert.deepEqual([(await api().cookies.jar('')).length, (await api().cookies.jar('dev')).length], [0, 0]);
    } finally {
      await cmd('httpme.showCollections');
    }
  },

  async 'Send pola BIMA: cookie tiap hop disimpan, auto re-login sekali lalu kirim ulang, Login di status bar, opsi cookie per request, Copy as cURL with Cookies'() {
    const b = await bima();
    const login = join(root(), 'zz-login.http');
    const home = join(root(), 'zz-home.http');
    try {
      await cmd('httpme.clearCookies', undefined, true);
      writeFileSync(login, `POST ${b.srv.url}/login\nContent-Type: application/x-www-form-urlencoded\n\nusername=u&password=p\n`);
      writeFileSync(home, `GET ${b.srv.url}/home\n`);
      const loginUri = vscode.Uri.file(login);
      const homeUri = vscode.Uri.file(home);

      // tanpa Login request: session habis tampil apa adanya (halaman login)
      await cmd('vscode.openWith', homeUri, 'httpme.request');
      await cmd('httpme.sendRequest');
      await until(() => api().viewOf(homeUri.toString())?.kind === 'response', 'response tanpa login');
      assert.equal(b.logins(), 0);

      await cmd('httpme.setLoginRequest', loginUri);
      assert.equal(api().cookies.loginRequest(), loginUri.toString());
      await cmd('httpme.sendRequest');
      await until(() => api().viewOf(homeUri.toString())?.note?.startsWith('Session expired'), 'auto re-login');
      assert.equal(b.logins(), 1);
      assert.match(b.seen.slice(-3).join('|'), /POST \/login -\|GET \/home S1\|GET \/home S1/, 'login → 302 + cookie → /home dengan cookie; request asli diulang dengan cookie');
      assert.deepEqual((await api().cookies.jar('')).map((c) => c.name), ['JSESSIONID']);

      // session masih berlaku: tanpa login lagi
      await cmd('httpme.sendRequest');
      await until(() => b.seen.length && b.seen[b.seen.length - 1] === 'GET /home S1' && api().viewOf(homeUri.toString())?.note === undefined, 'tanpa login');
      assert.equal(b.logins(), 1);

      // tombol Login di status bar: request login dijalankan, cookie baru tersimpan
      await cmd('httpme.login');
      await until(() => b.logins() === 2, 'status bar Login');
      await until(() => api().viewOf(loginUri.toString())?.kind === 'response', 'view login');
      assert.deepEqual(api().viewOf(loginUri.toString())!.timeline!.map((h) => h.status), [302, 200], 'Timeline: rantai redirect');
      assert.equal((await api().cookies.jar(''))[0].value, 'S2');

      // @no-send-cookies: cookie tersimpan tidak dikirim
      b.expire();
      writeFileSync(home, `# @no-send-cookies\n# @no-save-cookies\nGET ${b.srv.url}/home\n`);
      await wait(200);
      await cmd('vscode.openWith', homeUri, 'httpme.request');
      const before = b.logins();
      await cmd('httpme.sendRequest');
      await until(() => b.logins() === before + 1, 'login karena tanpa cookie');
      await wait(300);
      assert.ok(b.seen.filter((x) => x.startsWith('GET /home')).slice(-1)[0].endsWith(' -'), 'cookie tidak dikirim');

      // Copy as cURL: tanpa cookie, varian with Cookies menyertakan cookie jar
      await cmd('httpme.copyAsCurl', loginUri);
      assert.doesNotMatch(await vscode.env.clipboard.readText(), /-b /);
      writeFileSync(home, `GET ${b.srv.url}/home\n`);
      await cmd('httpme.copyAsCurlWithCookies', homeUri);
      assert.match(await vscode.env.clipboard.readText(), /-b 'JSESSIONID=S\d'/);
    } finally {
      await api().cookies.setLoginRequest(undefined);
      await cmd('workbench.action.closeAllEditors');
      await cmd('httpme.clearCookies', undefined, true);
      await b.srv.close();
      rmSync(login, { force: true });
      rmSync(home, { force: true });
    }
  },
};
