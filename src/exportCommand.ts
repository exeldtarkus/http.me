// Export… (lem VS Code): pilih collection → format + opsi → Save as (default exports/) → proses async (progress, Cancel) → popup hasil.
// Logika ada di exportRun / exportPostman / exportOpenapi / jetbrainsEnv.
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { Environments } from './envState';
import { GLOBALS } from './envState';
import { ExportCancelled, runExport, type ExportEnv, type ExportRunOptions, type ExportResult } from './exportRun';
import { listHistory } from './history';
import { openExportDialog } from './exportDialog';
import type { HistoryResponse } from './exportOpenapi';
import { errMsg } from './log';
import { log, reportError } from './output';

export const EXPORTS_DIR = 'exports';
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

/** Globals (bila berisi) untuk export Environments */
async function globalsOf(envs: Environments): Promise<{ globals?: ExportEnv }> {
  const vars = await envs.vars(GLOBALS).catch((e) => { log().error(`export.globals - ${errMsg(e)}`); return []; });
  return vars.length ? { globals: (await envData(envs, [GLOBALS]))[0] } : {};
}

/** History -> contoh response untuk export OpenAPI (hanya entri dengan status) */
async function historyResponses(historyDir: string): Promise<HistoryResponse[]> {
  const list = await listHistory(historyDir).catch((e) => { log().error(`export.history - ${errMsg(e)}`); return []; });
  return list.filter((h) => h.status !== undefined).map((h) => ({ method: h.method, url: h.url, status: h.status, ...(h.response?.contentType ? { contentType: h.response.contentType } : {}), ...(h.response?.body !== undefined ? { body: h.response.body } : {}) }));
}

/** jalur proses (dipakai tombol dan itest): progress + Cancel, tulis sekali di akhir */
export async function exportApply(root: string, choice: ExportChoice, envs: Environments, historyDir: string): Promise<ExportResult> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting ${basename(root)}…`, cancellable: true }, async (progress, token) => {
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    const { environments: ev, ...rest } = choice;
    const names = await envs.names();
    const opts: ExportRunOptions = { ...rest, root };
    if (ev) opts.environments = { list: await envData(envs, names), includeSecrets: ev.includeSecrets, ...(ev.jetbrains ? { jetbrains: true } : {}), ...(await globalsOf(envs)) };
    if (choice.format !== 'postman') {
      opts.envValues = await Promise.all(names.map(async (name) => ({ name, values: await envs.values(name) })));
      opts.history = await historyResponses(historyDir);
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
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? root;
  const res = await openExportDialog(root, ws, async () => {
    const names = await envs.names();
    const globals = (await globalsOf(envs)).globals;
    return {
      envs: await envData(envs, names), ...(globals ? { globals } : {}),
      envValues: await Promise.all(names.map(async (name) => ({ name, values: await envs.values(name) }))),
      history: await historyResponses(historyDir),
    };
  }, envs);
  if (!res) return;
  let { choice } = res;
  if (res.confirmSecrets) {
    const yes = await vscode.window.showWarningMessage('Export with secret values?', { modal: true, detail: 'Secret values will be written in plain text to the exported files. Add them to .gitignore.' }, 'Export with secrets');
    if (yes !== 'Export with secrets') choice = { ...choice, environments: { ...choice.environments!, includeSecrets: false } };
  }
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
