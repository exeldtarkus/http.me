// Open Dashboard (lem VS Code): satu halaman ringkasan Collections / Environments / Cookies + aksi cepat. Logika ringkasan ada di dashboard.ts.
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { shouldSkipDir, summarizeCollections, summarizeCookies, summarizeEnvironments } from './dashboard';
import { webviewPage } from './webviewPage';
import { errMsg } from './log';
import { reportError } from './output';
import type { Environments } from './envState';
import type { Cookies } from './cookies';

const MAX_FILES = 2000; // hemat RAM: workspace sangat besar hanya dipindai sebagian

async function scan(dir: string, root: string, out: { path: string; text: string }[]): Promise<void> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) return;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!shouldSkipDir(e.name)) await scan(p, root, out); }
    else if (/\.http$/i.test(e.name)) out.push({ path: relative(root, p).replace(/\\/g, '/'), text: await fs.readFile(p, 'utf8') });
  }
}

async function collect(envs: Environments, cookies: Cookies) {
  const root = vscode.workspace.workspaceFolders?.[0];
  const files: { path: string; text: string }[] = [];
  if (root?.uri.scheme === 'file') await scan(root.uri.fsPath, root.uri.fsPath, files);
  const names = await envs.names();
  const loaded = await Promise.all(names.map(async (name) => ({ name, vars: await envs.vars(name), values: await envs.values(name) })));
  const secretSet = Object.fromEntries(loaded.map((e) => [e.name, e.vars.filter((v) => v.secret && e.values.get(v.key) !== null).map((v) => v.key)]));
  const jars = await Promise.all((await cookies.environments()).map(async (env) => ({ env, cookies: await cookies.jar(env) })));
  return {
    type: 'data', at: Date.now(), workspace: root?.name ?? 'No folder',
    collections: summarizeCollections(files),
    environments: summarizeEnvironments(loaded, envs.active, secretSet),
    cookies: summarizeCookies(jars, Date.now()),
  };
}

let panel: vscode.WebviewPanel | undefined;

export function registerDashboard(envs: Environments, cookies: Cookies): vscode.Disposable {
  return vscode.commands.registerCommand('httpme.openDashboard', () => {
    if (panel) return panel.reveal();
    const p = vscode.window.createWebviewPanel('httpme.dashboard', 'http.me Dashboard', vscode.ViewColumn.Active, { enableScripts: true });
    panel = p;
    p.webview.html = webviewPage('dashboard', { cspSource: p.webview.cspSource, nonce: randomBytes(16).toString('base64') });
    const post = async () => { try { void p.webview.postMessage(await collect(envs, cookies)); } catch (e) { reportError('dashboard.collect', e, `http.me: ${errMsg(e)}`); } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => void post(), 400); };
    const subs = [
      envs.onDidChange(later),
      p.webview.onDidReceiveMessage(async (m: { type: string; cmd?: string; arg?: unknown }) => {
        try {
          if (m.type === 'ready' || m.type === 'refresh') return await post();
          if (m.type !== 'cmd') return;
          const arg = typeof m.arg === 'string' ? m.arg : undefined;
          // daftar putih: hanya aksi yang tampil di dashboard
          if (m.cmd === 'newRequest') await vscode.commands.executeCommand('httpme.newRequest');
          else if (m.cmd === 'import') await vscode.commands.executeCommand('httpme.import');
          else if (m.cmd === 'focusCollections') await vscode.commands.executeCommand('httpme.sidebar.focus');
          else if (m.cmd === 'newEnvironment') await vscode.commands.executeCommand('httpme.newEnvironment');
          else if (m.cmd === 'compareEnvironments') await vscode.commands.executeCommand('httpme.compareEnvironments');
          else if (m.cmd === 'setActive' && arg !== undefined) await vscode.commands.executeCommand('httpme.setActiveEnvironment', arg);
          else if (m.cmd === 'openEnvironment' && arg !== undefined) await vscode.commands.executeCommand('httpme.openEnvironment', arg);
          else if (m.cmd === 'clearCookies' && typeof m.arg === 'string') await vscode.commands.executeCommand('httpme.clearCookies', { kind: 'env', env: m.arg });
          else return;
          await post();
        } catch (e) {
          reportError(`dashboard.${m.type}`, e, `http.me: ${errMsg(e)}`);
        }
      }),
    ];
    p.onDidDispose(() => { clearTimeout(timer); subs.forEach((s) => s.dispose()); panel = undefined; });
  });
}
