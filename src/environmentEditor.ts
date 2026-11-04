// editor Environment = custom editor tabel di atas file JSON (.httpme/environments/<nama>.json / Globals): dirty/undo/save oleh VS Code.
// Perubahan struktur key (tambah / rename / hapus / secret) ikut ke semua Environment lain (Globals berdiri sendiri).
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { clearedKey, parseEnvironment, persistAll, renamedKey, serializeEnvironment, validateVars, withKey, withoutKey, withSecret, type EnvVar } from './environments';
import { GLOBALS, type Environments } from './envState';
import { webviewPage } from './webviewPage';
import { errMsg, errorLine } from './log';
import { log, reportError } from './output';

export const ENV_VIEW = 'httpme.environment';
export type FocusMode = 'show' | 'fill' | 'add';
type Focus = { key: string; mode: FocusMode };

let envs!: Environments;
const panels = new Map<string, Set<vscode.WebviewPanel>>();
/** Ctrl+Click / F12 / gotoVariable: key yang disorot saat editor tampil (berlaku 3 dtk untuk Definition) */
let pending: { uri: string; focus: Focus; at: number } | undefined;
/** fokus terakhir per uri (itest) */
const lastFocus = new Map<string, Focus>();

export type EnvOp =
  | { type: 'edit'; vars: EnvVar[] }
  | { type: 'addKey'; key: string; secret?: boolean }
  | { type: 'renameKey'; from: string; to: string }
  | { type: 'deleteKey'; key: string; scope?: 'all' | 'this' }
  | { type: 'setSecret'; key: string; secret: boolean }
  | { type: 'setCurrent'; key: string; value?: string }
  | { type: 'setSecretValue'; key: string; value?: string }
  | { type: 'resetCurrent' } | { type: 'persistAll' };

const nameOf = (doc: vscode.TextDocument): string => envs.nameOf(doc.uri) ?? doc.uri.path.split('/').pop()!.replace(/\.json$/i, '');

async function writeDoc(doc: vscode.TextDocument, vars: readonly EnvVar[]): Promise<void> {
  const text = serializeEnvironment(vars);
  if (doc.getText() === text) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  await vscode.workspace.applyEdit(edit);
}

/** pindahkan nilai secret / current value per Environment saat key di-rename / dihapus */
async function forEachEnv(names: string[], fn: (env: string) => Promise<void>): Promise<void> {
  for (const n of names) await fn(n);
}

/** satu operasi dari tabel (atau itest: ask = false, tanpa dialog) */
export async function envOp(doc: vscode.TextDocument, op: EnvOp, ask = true): Promise<void> {
  const name = nameOf(doc);
  const vars = parseEnvironment(doc.getText(), `${name || 'Globals'}.json`);
  const shared = name !== GLOBALS && envs.nameOf(doc.uri) !== undefined; // Globals tidak ikut aturan key sama
  const all = shared ? await envs.names() : [name];
  const others = all.filter((n) => n !== name);
  switch (op.type) {
    case 'edit': {
      if (!Array.isArray(op.vars) || validateVars(op.vars).length) return; // tidak valid: hanya ditandai merah di tabel, tidak disimpan
      return writeDoc(doc, op.vars.map((x) => ({ key: x.key.trim(), value: x.secret ? null : x.value, ...(x.secret ? { secret: true } : {}), ...(x.enabled === false ? { enabled: false } : {}) })));
    }
    case 'addKey': {
      const key = op.key.trim();
      if (!key || vars.some((x) => x.key === key)) return;
      await writeDoc(doc, withKey(vars, key, !!op.secret));
      if (shared) await envs.updateOthers((v) => withKey(v, key, !!op.secret), name);
      return;
    }
    case 'renameKey': {
      const to = op.to.trim();
      if (!to || to === op.from || vars.some((x) => x.key === to)) return;
      if (ask && shared && others.length) {
        const files = all.map((n) => `${n}.json`).join(', ');
        const ok = await vscode.window.showWarningMessage(`Rename ${op.from} to ${to} in every Environment?`, { modal: true, detail: `Changes: ${files}` }, 'Rename');
        if (ok !== 'Rename') return envs.fire();
      }
      await writeDoc(doc, renamedKey(vars, op.from, to));
      if (shared) await envs.updateOthers((v) => renamedKey(v, op.from, to), name);
      await forEachEnv(all, async (env) => {
        const s = await envs.secret(env, op.from);
        if (s !== undefined) { await envs.setSecret(env, to, s); await envs.setSecret(env, op.from, undefined); }
        const cur = envs.current(env);
        if (op.from in cur) { await envs.setCurrent(env, to, cur[op.from]); await envs.setCurrent(env, op.from, undefined); }
      });
      return;
    }
    case 'deleteKey': {
      let scope = op.scope;
      if (!scope && !shared) scope = 'all';
      if (!scope && ask) {
        const pick = await vscode.window.showWarningMessage(`Delete ${op.key}?`, { modal: true, detail: 'Every Environment has the same keys. Clear keeps the key with a NULL value.' },
          'Delete from every Environment', 'Clear in this Environment');
        scope = pick === 'Delete from every Environment' ? 'all' : pick === 'Clear in this Environment' ? 'this' : undefined;
      }
      if (!scope) return;
      if (scope === 'this') {
        await writeDoc(doc, clearedKey(vars, op.key));
        await envs.setSecret(name, op.key, undefined);
        await envs.setCurrent(name, op.key, undefined);
        return;
      }
      await writeDoc(doc, withoutKey(vars, op.key));
      if (shared) await envs.updateOthers((v) => withoutKey(v, op.key), name);
      await forEachEnv(all, async (env) => { await envs.setSecret(env, op.key, undefined); await envs.setCurrent(env, op.key, undefined); });
      return;
    }
    case 'setSecret': {
      // nilai pindah antara file dan SecretStorage di tiap Environment
      const { key, secret } = op;
      for (const env of all) {
        const v: EnvVar[] = env === name ? vars : await envs.vars(env);
        const x = v.find((y) => y.key === key);
        if (!x || !!x.secret === secret) continue;
        let after: EnvVar[];
        if (secret) {
          if (x.value !== null) await envs.setSecret(env, key, x.value);
          after = withSecret(v, key, true);
        } else {
          const back = (await envs.secret(env, key)) ?? null;
          await envs.setSecret(env, key, undefined);
          after = withSecret(v, key, false).map((y) => (y.key === key ? { ...y, value: back } : y));
        }
        if (env === name) await writeDoc(doc, after); else await envs.write(env, after);
      }
      return;
    }
    case 'setCurrent': return envs.setCurrent(name, op.key, op.value);
    case 'setSecretValue': return envs.setSecret(name, op.key, op.value);
    case 'resetCurrent': return envs.resetCurrent(name);
    case 'persistAll': await writeDoc(doc, persistAll(vars, envs.current(name))); return envs.resetCurrent(name);
  }
}

async function stateOf(doc: vscode.TextDocument): Promise<Record<string, unknown>> {
  const name = nameOf(doc);
  try {
    const vars = parseEnvironment(doc.getText(), `${name || 'Globals'}.json`);
    const secretSet: Record<string, boolean> = {};
    for (const x of vars) if (x.secret) secretSet[x.key] = (await envs.secret(name, x.key)) !== undefined;
    return { type: 'state', name: name || 'Globals', globals: name === GLOBALS, active: name !== GLOBALS && envs.active === name, vars, current: name === GLOBALS ? {} : envs.current(name), secretSet };
  } catch (e) {
    log().error(errorLine(`environmentEditor.state ${name}`, e)); // JSON rusak (edit manual): pesan tampil di editor, perbaiki lewat Open as Text
    return { type: 'state', name: name || 'Globals', globals: name === GLOBALS, error: errMsg(e) };
  }
}

function resolve(doc: vscode.TextDocument, panel: vscode.WebviewPanel): void {
  const key = doc.uri.toString();
  if (!panels.has(key)) panels.set(key, new Set());
  panels.get(key)!.add(panel);
  panel.webview.options = { enableScripts: true };
  panel.webview.html = webviewPage('environment', { cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64') });
  const post = async () => void panel.webview.postMessage(await stateOf(doc));
  const takeFocus = () => {
    if (!pending || pending.uri !== key || Date.now() - pending.at > 3000) return;
    const f = pending.focus;
    pending = undefined;
    lastFocus.set(key, f);
    void panel.webview.postMessage({ type: 'focus', ...f });
  };
  const subs = [
    panel.webview.onDidReceiveMessage(async (m: { type: string; key?: string; env?: string } & Record<string, unknown>) => {
      try {
        if (m.type === 'ready') { await post(); takeFocus(); } else if (m.type === 'setActive') await envs.setActive(nameOf(doc));
        else if (m.type === 'rename') await vscode.commands.executeCommand('httpme.renameEnvironment', nameOf(doc));
        else if (m.type === 'compare') await openCompare();
        else if (m.type === 'openAsText') await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
        else if (m.type === 'showSecret' && typeof m.key === 'string') {
          void panel.webview.postMessage({ type: 'secret', key: m.key, value: (await envs.secret(nameOf(doc), m.key)) ?? null });
        } else await envOp(doc, m as unknown as EnvOp);
      } catch (e) {
        reportError(`environmentEditor.${m.type}`, e, `http.me: ${errMsg(e)}`);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => { if (e.document === doc && e.contentChanges.length) void post(); }),
    envs.onDidChange(() => void post()),
    panel.onDidChangeViewState(() => { if (panel.active) takeFocus(); }),
  ];
  panel.onDidDispose(() => {
    subs.forEach((s) => s.dispose());
    panels.get(key)?.delete(panel);
  });
}

/** buka editor Environment / Globals dan sorot key (fill = sel NULL langsung jadi input, add = baris Add variable terisi) */
export async function focusVariable(uri: vscode.Uri, key: string, mode: FocusMode, open = true): Promise<void> {
  pending = { uri: uri.toString(), focus: { key, mode }, at: Date.now() };
  if (!open) return;
  const shown = [...(panels.get(uri.toString()) ?? [])][0];
  if (shown?.visible) {
    lastFocus.set(uri.toString(), { key, mode });
    pending = undefined;
    shown.reveal();
    void shown.webview.postMessage({ type: 'focus', key, mode });
  } else await vscode.commands.executeCommand('vscode.openWith', uri, ENV_VIEW);
}

export const focusOf = (uri: vscode.Uri): Focus | undefined => lastFocus.get(uri.toString());

// ---------- All Environments (matriks variable × environment) ----------
let compare: vscode.WebviewPanel | undefined;

async function compareState(): Promise<Record<string, unknown>> {
  const names = await envs.names();
  const columns = await Promise.all(names.map(async (name) => {
    const vars = await envs.vars(name).catch(() => [] as EnvVar[]); // file rusak: kolom kosong (pesan tampil saat file dibuka)
    const secretSet: Record<string, boolean> = {};
    for (const x of vars) if (x.secret) secretSet[x.key] = (await envs.secret(name, x.key)) !== undefined;
    return { name, vars: Object.fromEntries(vars.map((x) => [x.key, x.secret ? { secret: true, set: secretSet[x.key] } : { value: x.value }])) };
  }));
  const keys = [...new Set(columns.flatMap((c) => Object.keys(c.vars)))];
  return { type: 'state', active: envs.active, keys, columns };
}

export async function openCompare(): Promise<vscode.WebviewPanel> {
  if (compare) { compare.reveal(); return compare; }
  const panel = vscode.window.createWebviewPanel('httpme.compare', 'All Environments', vscode.ViewColumn.Active, { enableScripts: true });
  compare = panel;
  panel.webview.html = webviewPage('compare', { cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64') });
  const post = async () => void panel.webview.postMessage(await compareState());
  const subs = [
    panel.webview.onDidReceiveMessage(async (m: { type: string; env?: unknown; key?: unknown; value?: unknown }) => {
      try {
        if (m.type === 'ready') return post();
        if (m.type === 'open' && typeof m.env === 'string') return void await vscode.commands.executeCommand('vscode.openWith', envs.uriOf(m.env), ENV_VIEW);
        if (m.type === 'set' && typeof m.env === 'string' && typeof m.key === 'string' && (typeof m.value === 'string' || m.value === null)) await setValue(m.env, m.key, m.value);
      } catch (e) {
        reportError(`compare.${m.type}`, e, `http.me: ${errMsg(e)}`);
      }
    }),
    envs.onDidChange(() => void post()),
  ];
  panel.onDidDispose(() => { subs.forEach((s) => s.dispose()); compare = undefined; });
  return panel;
}

/** isi nilai satu key di satu Environment (matriks / Quick Fix): secret → SecretStorage, selain itu initial value di file */
export async function setValue(env: string, key: string, value: string | null): Promise<void> {
  const vars = await envs.vars(env);
  const x = vars.find((y) => y.key === key);
  if (x?.secret) return envs.setSecret(env, key, value ?? undefined);
  await envs.write(env, x ? vars.map((y) => (y.key === key ? { ...y, value } : y)) : [...vars, { key, value }]);
}

/** isi matriks All Environments (itest) */
export const compareView = compareState;

export function registerEnvironmentEditor(e: Environments): vscode.Disposable {
  envs = e;
  return vscode.window.registerCustomEditorProvider(ENV_VIEW, { resolveCustomTextEditor: resolve }, { webviewOptions: { retainContextWhenHidden: false } });
}
