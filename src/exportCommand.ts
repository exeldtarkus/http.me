// Export… (lem VS Code): pilih collection → format + opsi → Save as (default exports/) → proses async (progress, Cancel) → popup hasil.
// Logika ada di exportRun / exportPostman / exportOpenapi / jetbrainsEnv.
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { Environments } from './envState';
import { GLOBALS } from './envState';
import { ExportCancelled, runExport, type ExportEnv, type ExportRunOptions, type ExportResult } from './exportRun';
import { listHistory } from './history';
import { errMsg } from './log';
import { log, reportError } from './output';

export const EXPORTS_DIR = 'exports';
type Fmt = { label: string; description: string; format: ExportRunOptions['format']; yaml?: boolean; ext: string };
const FORMATS: Fmt[] = [
  { label: 'Postman Collection v2.1', description: 'JSON · folders, auth, scripts, variables', format: 'postman', ext: 'postman_collection.json' },
  { label: 'OpenAPI 3.0.3 (JSON)', description: 'servers from Environments, tags, schemas from examples', format: '3.0.3', ext: 'openapi.json' },
  { label: 'OpenAPI 3.1.0 (JSON)', description: '', format: '3.1.0', ext: 'openapi.json' },
  { label: 'OpenAPI 3.0.3 (YAML)', description: '', format: '3.0.3', yaml: true, ext: 'openapi.yaml' },
  { label: 'OpenAPI 3.1.0 (YAML)', description: '', format: '3.1.0', yaml: true, ext: 'openapi.yaml' },
];

/** pilihan lengkap (itest / pemanggil lain melewati dialog) */
export type ExportChoice = Omit<ExportRunOptions, 'root' | 'environments' | 'envValues' | 'history'> & { environments?: { includeSecrets: boolean; jetbrains?: boolean } };

async function hasHttp(dir: string): Promise<boolean> {
  const walk = async (d: string): Promise<boolean> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== EXPORTS_DIR && e.name !== 'node_modules' && await walk(join(d, e.name))) return true;
      if (e.isFile() && /\.http$/i.test(e.name)) return true;
    }
    return false;
  };
  return walk(dir);
}

async function envData(envs: Environments, names: readonly string[]): Promise<ExportEnv[]> {
  return Promise.all(names.map(async (name) => {
    const vars = await envs.vars(name);
    const secrets: Record<string, string> = {};
    for (const v of vars) if (v.secret) { const s = await envs.secret(name, v.key); if (s !== undefined) secrets[v.key] = s; }
    return { name, vars, secrets };
  }));
}

/** jalur proses (dipakai tombol dan itest): progress + Cancel, tulis sekali di akhir */
export async function exportApply(root: string, choice: ExportChoice, envs: Environments, historyDir: string): Promise<ExportResult> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting ${basename(root)}…`, cancellable: true }, async (progress, token) => {
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    const { environments: ev, ...rest } = choice;
    const names = await envs.names();
    const opts: ExportRunOptions = { ...rest, root };
    if (ev) opts.environments = { list: await envData(envs, names), includeSecrets: ev.includeSecrets, ...(ev.jetbrains ? { jetbrains: true } : {}), ...((await envs.vars(GLOBALS).catch(() => [])).length ? { globals: (await envData(envs, [GLOBALS]))[0] } : {}) };
    if (choice.format !== 'postman') {
      opts.envValues = await Promise.all(names.map(async (name) => ({ name, values: await envs.values(name) })));
      opts.history = (await listHistory(historyDir).catch((e) => { log().error(`export.history - ${errMsg(e)}`); return []; })).filter((h) => h.status !== undefined).map((h) => ({ method: h.method, url: h.url, ...(h.status !== undefined ? { status: h.status } : {}) }));
    }
    let prev = 0;
    return runExport(opts, ac.signal, (d, t, p) => { progress.report({ increment: ((d - prev) / t) * 100, message: `${d} / ${t} · ${p}` }); prev = d; });
  });
}

async function pickCollection(dir: vscode.Uri): Promise<string | undefined> {
  const entries = await fs.readdir(dir.fsPath, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && /\.http$/i.test(e.name))) return dir.fsPath;
  const subs: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== EXPORTS_DIR && e.name !== 'node_modules' && await hasHttp(join(dir.fsPath, e.name))) subs.push(e.name);
  }
  if (subs.length === 1) return join(dir.fsPath, subs[0]);
  if (!subs.length) throw new Error('No .http files to export here');
  const pick = await vscode.window.showQuickPick(subs.map((s) => ({ label: s })), { title: 'Export: choose a collection' });
  return pick && join(dir.fsPath, pick.label);
}

async function ask(root: string, envs: Environments, historyDir: string): Promise<void> {
  const fmt = await vscode.window.showQuickPick(FORMATS.map((f) => ({ ...f })), { title: 'Export format' });
  if (!fmt) return;
  const children = (await fs.readdir(root, { withFileTypes: true })).filter((e) => !e.name.startsWith('.') && e.name !== EXPORTS_DIR && (e.isDirectory() || /\.http$/i.test(e.name)));
  const incl = await vscode.window.showQuickPick(children.map((e) => ({ label: e.name, description: e.isDirectory() ? 'folder' : 'request', picked: true })), { title: 'Requests to include', canPickMany: true });
  if (!incl) return;
  const opt = fmt.format === 'postman' ? [
    { label: 'Include Environments', id: 'env', picked: false }, { label: 'Translate scripts (httpme.* → pm.*)', id: 'scripts', picked: true },
    { label: 'Export Environments as http-client.env.json (JetBrains)', id: 'jb', picked: false }, { label: 'Include secret values', id: 'secret', picked: false },
  ] : [];
  const chosen = opt.length ? await vscode.window.showQuickPick(opt, { title: 'Options', canPickMany: true }) : [];
  if (!chosen) return;
  const on = (id: string) => chosen.some((c) => c.id === id);
  let includeSecrets = on('secret');
  if (includeSecrets) {
    const yes = await vscode.window.showWarningMessage('Export with secret values?', { modal: true, detail: 'Secret values will be written in plain text to the exported files. Add them to .gitignore.' }, 'Export with secrets');
    includeSecrets = yes === 'Export with secrets';
  }
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? root;
  const target = await vscode.window.showSaveDialog({ title: 'Save export as', defaultUri: vscode.Uri.file(join(ws, EXPORTS_DIR, `${basename(root)}.${fmt.ext}`)), filters: { Export: [fmt.ext.split('.').slice(-1)[0]] } });
  if (!target) return;
  const keep = new Set(incl.map((i) => i.label));
  const choice: ExportChoice = {
    format: fmt.format, ...(fmt.yaml ? { yaml: true } : {}), outFile: target.fsPath, translateScripts: on('scripts'),
    include: (rel) => keep.has(rel.split('/')[0]) || !rel.includes('/') && !children.some((c) => c.name === rel),
    ...(on('env') || on('jb') ? { environments: { includeSecrets, ...(on('jb') ? { jetbrains: true } : {}) } } : {}),
  };
  await runAndReport(root, choice, envs, historyDir, ws);
}

async function runAndReport(root: string, choice: ExportChoice, envs: Environments, historyDir: string, ws: string): Promise<void> {
  try {
    const res = await exportApply(root, choice, envs, historyDir);
    for (const w of res.warnings) log().warn(`export: ${w}`);
    const rel = relative(ws, res.files[0]);
    const extra = res.files.length > 1 ? ` + ${res.files.length - 1} environment file${res.files.length === 2 ? '' : 's'}` : '';
    const partial = res.skipped.length > 0;
    const msg = partial ? `Exported ${res.requests} of ${res.requests + res.skipped.length} requests (${rel}${extra}). Skipped: ${res.skipped.join(', ')}` : `Exported ${res.requests} request${res.requests === 1 ? '' : 's'} (${rel}${extra})`;
    const pick = await (partial ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(msg, 'Open file', 'Reveal in Explorer', ...(res.warnings.length ? ['Show log'] : []));
    if (pick === 'Open file') await vscode.window.showTextDocument(vscode.Uri.file(res.files[0]));
    else if (pick === 'Reveal in Explorer') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(res.files[0]));
    else if (pick === 'Show log') log().show(true);
  } catch (e) {
    if (e instanceof ExportCancelled) return void vscode.window.showInformationMessage('Export cancelled. No file was written.');
    reportError('export', e, `Export failed: ${errMsg(e)}`);
  }
}

/** `dir` = folder collection (atau root yang berisi beberapa collection) */
export async function exportCollection(dir: vscode.Uri, envs: Environments, historyDir: string): Promise<void> {
  const root = await pickCollection(dir);
  if (root) await ask(root, envs, historyDir);
}
