// Open Dashboard (lem VS Code): 3 tab Collections / Environments / Cookies dengan semua fungsi sidebar. Data & tree murni ada di dashboard.ts;
// aksi diteruskan ke command yang sama dengan sidebar (konfirmasi delete dll. tetap dari command itu).
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { buildCollectionTree, buildCookieTree, shouldSkipDir, summarizeCollections, summarizeEnvironments } from './dashboard';
import { KEEP_FILE } from './store';
import { webviewPage } from './webviewPage';
import { errMsg } from './log';
import { log, reportError } from './output';
import { maskCookie } from './httpEditor';
import { moveInto } from './sidebar';
import { COMPARE_KEY, markOpened, pruneOpened } from './backBar';
import type { Environments } from './envState';
import type { Cookies } from './cookies';

const MAX_FILES = 2000; // hemat RAM: workspace sangat besar hanya dipindai sebagian

async function scan(dir: string, root: string, out: { files: { path: string; text: string }[]; keeps: string[] }): Promise<void> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (out.files.length >= MAX_FILES) return;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!shouldSkipDir(e.name)) await scan(p, root, out); }
    else if (e.name === KEEP_FILE) out.keeps.push(relative(root, dir).replace(/\\/g, '/'));
    else if (/\.http$/i.test(e.name)) out.files.push({ path: relative(root, p).replace(/\\/g, '/'), text: await fs.readFile(p, 'utf8') });
  }
}

async function collect(envs: Environments, cookies: Cookies) {
  const root = vscode.workspace.workspaceFolders?.[0];
  const found = { files: [] as { path: string; text: string }[], keeps: [] as string[] };
  if (root?.uri.scheme === 'file') await scan(root.uri.fsPath, root.uri.fsPath, found);
  const sum = summarizeCollections(found.files);
  const names = await envs.names();
  const loaded = await Promise.all(names.map(async (name) => ({ name, vars: await envs.vars(name), values: await envs.values(name) })));
  const secretSet = Object.fromEntries(loaded.map((e) => [e.name, e.vars.filter((v) => v.secret && e.values.get(v.key) !== null).map((v) => v.key)]));
  const env = summarizeEnvironments(loaded, envs.active, secretSet);
  const globals = await envs.vars('').catch((e) => { log().error(`dashboard.globals - ${errMsg(e)}`); return []; }); // Globals belum ada: 0 variable
  const jars = await Promise.all((await cookies.environments()).map(async (e) => ({ env: e, cookies: await cookies.jar(e) })));
  const tree = buildCookieTree(jars, Date.now(), maskCookie);
  return {
    type: 'data', workspace: root?.name ?? 'No folder',
    collections: { tree: buildCollectionTree(found.files, found.keeps), requests: sum.requests, files: sum.files },
    environments: { ...env, list: env.environments.length, globals: globals.length },
    cookies: { total: tree.reduce((n, e) => n + e.cookies, 0), tree },
  };
}

/** path relatif dari webview → Uri di root workspace; `..` / absolut ditolak */
function uriOf(rel: unknown): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error('Open a folder first.');
  if (typeof rel !== 'string' || rel.split(/[\\/]/).includes('..') || /^([a-zA-Z]:|[\\/])/.test(rel)) throw new Error('Invalid path.');
  return rel ? vscode.Uri.joinPath(root, rel) : root;
}
const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);
const exec = (cmd: string, ...args: unknown[]) => vscode.commands.executeCommand(cmd, ...args);

type Args = Record<string, unknown>;
type Handler = (a: Args) => unknown;

function handlers(envs: Environments, cookies: Cookies): Record<string, Handler> {
  const file = (cmd: string): Handler => (a) => exec(cmd, uriOf(a.path));
  const opens = (cmd: string): Handler => (a) => { const u = uriOf(a.path); markOpened(u); return exec(cmd, u); };
  const env = (cmd: string): Handler => (a) => exec(cmd, str(a.name));
  const envOpens = (cmd: string, arg: (a: Args) => unknown = (a) => str(a.name)): Handler => (a) => { markOpened(envs.uriOf(str(a.name) ?? '')); return exec(cmd, arg(a)); };
  /** cookie asli dicari ulang di jar (webview hanya punya nilai yang di-mask) */
  const node = async (a: Args) => {
    const e = str(a.env) ?? '';
    const c = (await cookies.jar(e)).find((x) => x.name === a.name && x.domain === a.domain && x.path === a.path);
    if (!c) throw new Error('The cookie no longer exists.');
    return { kind: 'ccookie', env: e, domain: c.domain, cookie: c };
  };
  return {
    // Collections
    'coll.newRequest': () => exec('httpme.newRequest'), 'coll.newCollection': () => exec('httpme.newCollection'), 'coll.newFolder': () => exec('httpme.newFolder'), 'coll.import': () => exec('httpme.import'), 'coll.export': () => exec('httpme.export'),
    'coll.importText': (a) => exec('httpme.import', 'text', a.items),
    'file.open': opens('httpme.openRequest'), 'file.openAsText': opens('httpme.openAsText'), 'file.duplicate': file('httpme.duplicate'), 'file.rename': file('httpme.rename'), 'file.reveal': file('httpme.revealInExplorer'),
    'file.copyAsCurl': file('httpme.copyAsCurl'), 'file.copyAsCurlWithCookies': file('httpme.copyAsCurlWithCookies'), 'file.copyAsCurlCmd': file('httpme.copyAsCurlCmd'),
    'file.copyAsCurlCmdWithCookies': file('httpme.copyAsCurlCmdWithCookies'), 'file.copyAsPowerShell': file('httpme.copyAsPowerShell'), 'file.copyAsPowerShellWithCookies': file('httpme.copyAsPowerShellWithCookies'),
    'file.setLoginRequest': file('httpme.setLoginRequest'),
    'file.delete': async (a) => {
      const paths = Array.isArray(a.paths) ? a.paths.filter((p): p is string => typeof p === 'string') : [];
      if (paths.length === 1) return exec('httpme.delete', uriOf(paths[0]));
      if (!paths.length) return undefined;
      // satu konfirmasi untuk semua item terpilih, lalu hapus satu per satu tanpa bertanya lagi
      const ok = await vscode.window.showWarningMessage(`Delete ${paths.length} items?`, { modal: true, detail: 'They are moved to the trash when the location has one.' }, 'Delete');
      if (ok !== 'Delete') return undefined;
      for (const p of paths) await exec('httpme.delete', uriOf(p), true);
      return undefined;
    },
    'folder.newRequest': file('httpme.newRequestIn'), 'folder.newFolder': file('httpme.newFolder'), 'folder.rename': file('httpme.rename'), 'folder.reimport': file('httpme.reimportFromSource'), 'folder.export': file('httpme.export'),
    move: async (a) => {
      const from = Array.isArray(a.from) ? a.from.map(uriOf) : [];
      if (from.length) await moveInto(from, uriOf(a.to));
    },
    // Environments
    'env.setActive': env('httpme.setActiveEnvironment'), 'env.open': envOpens('httpme.openEnvironment'), 'env.openAsText': envOpens('httpme.openEnvironmentAsText'), 'env.rename': env('httpme.renameEnvironment'),
    'env.duplicate': env('httpme.duplicateEnvironment'), 'env.delete': env('httpme.deleteEnvironment'), 'env.reveal': env('httpme.revealEnvironment'),
    'env.new': () => exec('httpme.newEnvironment'), 'env.import': () => exec('httpme.importEnvironment'), 'env.compare': () => { markOpened(COMPARE_KEY); return exec('httpme.compareEnvironments'); }, 'env.sync': () => exec('httpme.syncEnvironments'),
    'env.openGlobals': () => { markOpened(envs.globalsUri); return exec('httpme.openGlobals'); }, 'env.openGlobalsText': () => { markOpened(envs.globalsUri); return exec('httpme.openEnvironmentAsText', { kind: 'eglobals' }); },
    'env.addVariable': async () => {
      const name = await vscode.window.showInputBox({ title: 'Add Variable to Every Environment', prompt: 'Variable name (NULL in every Environment until you fill it)', validateInput: (v) => (/^[\w.-]+$/.test(v.trim()) || !v ? undefined : 'Use letters, digits, _ . -') });
      if (name?.trim()) await exec('httpme.addVariableToAll', name.trim());
    },
    // Cookies
    'cookie.add': (a) => exec('httpme.addCookie', { kind: 'cdomain', env: str(a.env) ?? cookies.env, domain: str(a.domain) }),
    'cookie.paste': (a) => exec('httpme.pasteCookies', { kind: 'cdomain', env: str(a.env) ?? cookies.env, domain: str(a.domain) }),
    'cookie.edit': async (a) => exec('httpme.editCookie', await node(a)), 'cookie.delete': async (a) => exec('httpme.deleteCookie', await node(a)),
    'cookie.deleteDomain': (a) => exec('httpme.deleteCookieDomain', { kind: 'cdomain', env: str(a.env) ?? '', domain: str(a.domain) }),
    'cookie.clearEnv': (a) => exec('httpme.clearCookies', { kind: 'cenv', env: str(a.env) ?? '' }), 'cookie.clearAll': () => exec('httpme.clearCookies'),
  };
}

let panel: vscode.WebviewPanel | undefined;

export function registerDashboard(envs: Environments, cookies: Cookies): vscode.Disposable {
  const table = handlers(envs, cookies);
  const back = vscode.commands.registerCommand('httpme.backToDashboard', () => vscode.commands.executeCommand('httpme.openDashboard'));
  const tabs = vscode.window.tabGroups.onDidChangeTabs(pruneOpened);
  const open = vscode.commands.registerCommand('httpme.openDashboard', () => {
    if (panel) return panel.reveal();
    const p = vscode.window.createWebviewPanel('httpme.dashboard', 'http.me Dashboard', vscode.ViewColumn.Active, { enableScripts: true });
    panel = p;
    p.webview.html = webviewPage('dashboard', { cspSource: p.webview.cspSource, nonce: randomBytes(16).toString('base64') });
    const post = async () => { try { void p.webview.postMessage(await collect(envs, cookies)); } catch (e) { reportError('dashboard.collect', e, `http.me: ${errMsg(e)}`); } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => void post(), 300); };
    const watchers = [vscode.workspace.createFileSystemWatcher('**/*.http'), vscode.workspace.createFileSystemWatcher(`**/${KEEP_FILE}`)];
    for (const w of watchers) { w.onDidCreate(later); w.onDidDelete(later); w.onDidChange(later); }
    const subs = [
      ...watchers, envs.onDidChange(later), p.onDidChangeViewState((e) => { if (e.webviewPanel.visible) later(); }),
      p.webview.onDidReceiveMessage(async (m: { type: string; id?: string; args?: Args; text?: string }) => {
        try {
          if (m.type === 'ready' || m.type === 'refresh') return await post();
          if (m.type === 'note' && m.text) return void vscode.window.showInformationMessage(m.text);
          if (m.type !== 'act' || !m.id) return;
          const h = table[m.id]; // daftar putih: id tak dikenal diabaikan
          if (!h) return;
          await h(m.args ?? {});
          await post();
        } catch (e) {
          reportError(`dashboard.${m.id ?? m.type}`, e, `http.me: ${errMsg(e)}`);
        }
      }),
    ];
    p.onDidDispose(() => { clearTimeout(timer); subs.forEach((s) => s.dispose()); panel = undefined; });
  });
  return vscode.Disposable.from(open, back, tabs);
}
