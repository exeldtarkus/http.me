// cookie jar per Environment di extension host (lem tipis VS Code): jar di memory + chunk disk httpme-cache/cookies (0600),
// Login request per Environment + tombol Login di status bar. Logika cookie di cookieJar.ts, deteksi session di login.ts.
import * as vscode from 'vscode';
import { join } from 'node:path';
import { readChunks } from './cache';
import { cookieHeader, jarCookieValues, loadJar, parseCookiePaste, saveJar, storeCookies, type Cookie } from './cookieJar';
import type { SendOptions } from './http';
import type { Environments } from './envState';
import { errMsg, errorLine } from './log';
import { log, reportError } from './output';

const LOGIN_KEY = 'login.requests';
/** Environment tanpa nama (No Environment) punya jar sendiri */
export const NO_ENV = '';

export class Cookies {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private jars = new Map<string, Promise<Cookie[]>>();
  /** isi jar terbaru per Environment (sinkron, untuk header Cookie tiap hop) */
  private latest = new Map<string, Cookie[]>();
  readonly dir: string;

  constructor(private ctx: vscode.ExtensionContext, private envs: Environments) {
    this.dir = join(vscode.Uri.joinPath(ctx.globalStorageUri, 'httpme-cache').fsPath, 'cookies');
  }

  get env(): string { return this.envs.active ?? NO_ENV; }

  jar(env: string): Promise<Cookie[]> {
    let j = this.jars.get(env);
    if (!j) {
      j = loadJar(this.dir, env).catch((e) => { log().error(errorLine(`Cookies.jar ${env}`, e)); return [] as Cookie[]; })
        .then((list) => { if (!this.latest.has(env)) this.latest.set(env, list); return this.latest.get(env)!; });
      this.jars.set(env, j);
    }
    return j;
  }

  /** ganti isi jar + simpan ke disk (berurutan per Environment supaya tulis tidak saling menimpa) */
  private writes = new Map<string, Promise<void>>();
  async setJar(env: string, jar: Cookie[]): Promise<void> {
    this.jars.set(env, Promise.resolve(jar));
    this.latest.set(env, jar);
    const prev = this.writes.get(env) ?? Promise.resolve();
    const next = prev.then(() => saveJar(this.dir, env, jar)).catch((e) => log().error(errorLine(`Cookies.save ${env}`, e)));
    this.writes.set(env, next);
    this.changed.fire();
    await next;
  }

  /** Environment yang punya cookie (+ Environment aktif) */
  async environments(): Promise<string[]> {
    const keys = (await readChunks(this.dir)).map(([k]) => k.slice(0, k.indexOf('|')));
    for (const [env, j] of this.jars) if ((await j).length) keys.push(env);
    keys.push(this.env);
    return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
  }

  /** opsi cookies untuk send(): kirim / simpan sesuai opsi request; Set-Cookie disimpan langsung (tiap hop) */
  async sendOptions(flags: { send: boolean; save: boolean }, env = this.env): Promise<SendOptions['cookies']> {
    if (!flags.send && !flags.save) return undefined;
    await this.jar(env);
    // selalu isi jar terbaru: request ulang setelah auto login memakai cookie hasil login
    const now = () => this.latest.get(env) ?? [];
    return {
      get: (url) => (flags.send ? cookieHeader(now(), url, Date.now()) : undefined),
      set: (url, list) => { if (flags.save) void this.setJar(env, storeCookies(now(), list, url, Date.now())); },
    };
  }

  /** cookie yang akan dikirim ke URL (tab Cookies di panel request) */
  async forUrl(url: string, env = this.env): Promise<{ name: string; value: string; domain: string; path: string }[]> {
    let u: URL;
    try { u = new URL(url); } catch { return []; } // URL belum lengkap / masih berisi {{var}}: belum ada cookie yang cocok
    const header = cookieHeader(await this.jar(env), u, Date.now());
    if (!header) return [];
    const jar = await this.jar(env);
    return header.split('; ').map((p) => {
      const name = p.slice(0, p.indexOf('='));
      const c = jar.find((x) => x.name === name && `${x.name}=${x.value}` === p)!;
      return { name, value: c.value, domain: c.domain, path: c.path };
    });
  }

  /** semua nilai cookie (di-mask di log) */
  async values(): Promise<string[]> { return jarCookieValues(await this.jar(this.env)); }

  async paste(env: string, domain: string, text: string): Promise<number> {
    const add = parseCookiePaste(text, domain.trim().toLowerCase(), Date.now());
    let jar = await this.jar(env);
    for (const c of add) jar = [...jar.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path)), c];
    await this.setJar(env, jar);
    return add.length;
  }
  async remove(env: string, match: (c: Cookie) => boolean): Promise<void> {
    await this.setJar(env, (await this.jar(env)).filter((c) => !match(c)));
  }
  async edit(env: string, target: Cookie, value: string): Promise<void> {
    await this.setJar(env, (await this.jar(env)).map((c) => (c.name === target.name && c.domain === target.domain && c.path === target.path ? { ...c, value } : c)));
  }

  // ---------- Login request per Environment ----------
  loginRequest(env = this.env): string | undefined { return this.ctx.workspaceState.get<Record<string, string>>(LOGIN_KEY, {})[env]; }
  async setLoginRequest(uri: string | undefined, env = this.env): Promise<void> {
    const all = { ...this.ctx.workspaceState.get<Record<string, string>>(LOGIN_KEY, {}) };
    if (uri === undefined) delete all[env]; else all[env] = uri;
    await this.ctx.workspaceState.update(LOGIN_KEY, all);
    this.changed.fire();
  }

  dispose(): void { this.changed.dispose(); }
}

/** status bar: tombol Login bila Environment aktif punya Login request */
export function registerLoginStatus(cookies: Cookies, envs: Environments): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('httpme.login', vscode.StatusBarAlignment.Left, 48);
  item.name = 'http.me Login';
  item.command = 'httpme.login';
  const update = () => {
    const uri = cookies.loginRequest();
    if (!uri) return item.hide();
    item.text = '$(key) Login';
    item.tooltip = `Run the Login request of ${envs.active ? `Environment "${envs.active}"` : 'No Environment'}: ${vscode.workspace.asRelativePath(vscode.Uri.parse(uri))}`;
    item.show();
  };
  update();
  return vscode.Disposable.from(item, cookies.onDidChange(update), envs.onDidChange(update));
}

type CookieNode = { kind: string; env?: string; domain?: string; cookie?: Cookie };
const envLabel = (env: string) => (env ? `Environment "${env}"` : 'No Environment');

/** command Cookies (sidebar) + Login request; argumen tambahan = input itest (tanpa dialog) */
export function registerCookieCommands(cookies: Cookies, run: (uri: vscode.Uri) => Promise<unknown>): vscode.Disposable {
  const cmd = (id: string, fn: (...a: never[]) => unknown) => vscode.commands.registerCommand(id, (...args: never[]) =>
    Promise.resolve().then(() => fn(...args)).catch((e) => reportError(id, e, `http.me: ${errMsg(e)}`)));
  const askDomain = async (value = '') => vscode.window.showInputBox({ title: 'Cookie domain', value, placeHolder: 'api.example.com', validateInput: (v) => (/^[\w.-]+$/.test(v.trim()) ? undefined : 'Domain only, e.g. api.example.com') });
  const envOf = (n?: CookieNode) => n?.env ?? cookies.env;

  return vscode.Disposable.from(
    cmd('httpme.addCookie', async (n?: CookieNode, domain?: string, text?: string) => {
      domain ??= n?.domain ?? (await askDomain());
      if (!domain) return;
      text ??= await vscode.window.showInputBox({ title: `Add cookie for ${domain}`, placeHolder: 'name=value', validateInput: (v) => (/^[^=;\s]+=/.test(v.trim()) ? undefined : 'Use name=value') });
      if (!text) return;
      await cookies.paste(envOf(n), domain, text);
    }),
    cmd('httpme.pasteCookies', async (n?: CookieNode, domain?: string, text?: string) => {
      text ??= await vscode.env.clipboard.readText();
      domain ??= n?.domain ?? (await askDomain());
      if (!domain) return;
      const count = await cookies.paste(envOf(n), domain, text);
      void vscode.window.showInformationMessage(count ? `Pasted ${count} cookie${count === 1 ? '' : 's'} for ${domain} (${envLabel(envOf(n))}).` : 'The clipboard has no cookies (expected JSESSIONID=… or a Cookie: header).');
    }),
    cmd('httpme.editCookie', async (n?: CookieNode, value?: string) => {
      if (!n?.cookie) return;
      value ??= await vscode.window.showInputBox({ title: `Edit cookie ${n.cookie.name} (${n.cookie.domain})`, password: true, prompt: 'New value (the current value stays hidden)' });
      if (value === undefined) return;
      await cookies.edit(envOf(n), n.cookie, value);
    }),
    cmd('httpme.deleteCookie', async (n?: CookieNode) => {
      const c = n?.cookie;
      if (c) await cookies.remove(envOf(n), (x) => x.name === c.name && x.domain === c.domain && x.path === c.path);
    }),
    cmd('httpme.deleteCookieDomain', async (n?: CookieNode, confirmed?: boolean) => {
      if (!n?.domain) return;
      if (!confirmed && (await vscode.window.showWarningMessage(`Delete all cookies of ${n.domain} (${envLabel(envOf(n))})?`, { modal: true }, 'Delete')) !== 'Delete') return;
      await cookies.remove(envOf(n), (c) => c.domain === n.domain);
    }),
    cmd('httpme.clearCookies', async (n?: CookieNode, confirmed?: boolean) => {
      const envs = n?.env !== undefined ? [n.env] : await cookies.environments();
      const what = n?.env !== undefined ? `all cookies of ${envLabel(n.env)}` : 'all saved cookies of every Environment';
      if (!confirmed && (await vscode.window.showWarningMessage(`Delete ${what}?`, { modal: true, detail: 'You may have to log in again.' }, 'Delete')) !== 'Delete') return;
      for (const env of envs) await cookies.setJar(env, []);
    }),
    // Login request per Environment
    cmd('httpme.setLoginRequest', async (a?: vscode.Uri | { uri?: vscode.Uri }) => {
      const uri = a instanceof vscode.Uri ? a : a?.uri ?? (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined)?.uri;
      if (!uri || !/\.http$/i.test(uri.path)) return void vscode.window.showInformationMessage('Select a .http request to use as Login request.');
      await cookies.setLoginRequest(uri.toString());
      void vscode.window.showInformationMessage(`${vscode.workspace.asRelativePath(uri)} is the Login request of ${envLabel(cookies.env)}.`);
    }),
    cmd('httpme.clearLoginRequest', () => cookies.setLoginRequest(undefined)),
    cmd('httpme.login', async () => {
      const uri = cookies.loginRequest();
      if (!uri) {
        const pick = await vscode.window.showInformationMessage(`${envLabel(cookies.env)} has no Login request. Right-click a request in Collections → Set as Login Request.`, 'Show Collections');
        if (pick) await vscode.commands.executeCommand('httpme.showCollections');
        return;
      }
      await run(vscode.Uri.parse(uri));
    }),
  );
}
