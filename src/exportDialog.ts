// dialog Export (webview): format, opsi, tree centang bertingkat, peringatan, pratinjau live (lem VS Code; logika di exportRun / exportCommand)
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import type { Environments } from './envState';
import { buildExport, includeSelected, loadOriginal, previewText, readCollection, type ExportBuildOptions } from './exportRun';
import type { ExportChoice } from './exportCommand';
import { errMsg } from './log';
import { reportError, log } from './output';
import { requestSummary } from './sidebarModel';
import { webviewPage } from './webviewPage';

export type DialogData = { envs: NonNullable<ExportBuildOptions['environments']>['list']; globals?: NonNullable<ExportBuildOptions['environments']>['globals']; envValues: NonNullable<ExportBuildOptions['envValues']>; history: NonNullable<ExportBuildOptions['history']> };

type Msg = { type: string; seq?: number; format?: 'postman' | '3.0.3' | '3.1.0'; yaml?: boolean; out?: string; selected?: string[]; translateScripts?: boolean; env?: boolean; jetbrains?: boolean; secrets?: boolean };

const EXT = (format: string, yaml: boolean) => (format === 'postman' ? 'postman_collection.json' : `openapi.${yaml ? 'yaml' : 'json'}`);

/** buka dialog; selesai dengan pilihan user (Export) atau undefined (Cancel / tab ditutup) */
export async function openExportDialog(root: string, ws: string, load: () => Promise<DialogData>, _envs: Environments): Promise<{ choice: ExportChoice; confirmSecrets: boolean } | undefined> {
  const name = basename(root);
  const files = await readCollection(root);
  const data = await load();
  const orig = await loadOriginal(root);
  if (orig.warning) log().warn(`export: ${orig.warning}`);
  const items = files.filter((f) => /\.http$/i.test(f.path) && !/(^|\/)_auth\.http$/.test(f.path)).map((f) => {
    const s = requestSummary(f.content);
    return { path: f.path, ...(s.method ? { method: s.method } : {}), ...(s.title ? { title: s.title } : {}) };
  });
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel('httpme.exportDialog', `Export: ${name}`, vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.html = webviewPage('exportDialog', { cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64') });
    let settled = false;
    const finish = (r: { choice: ExportChoice; confirmSecrets: boolean } | undefined) => { if (settled) return; settled = true; resolve(r); panel.dispose(); };
    const outOf = (m: Msg) => m.out?.trim() || join(ws, 'exports', `${name}.${EXT(m.format ?? 'postman', !!m.yaml)}`);
    const optionsOf = (m: Msg): ExportBuildOptions => ({
      format: m.format ?? 'postman', ...(m.yaml ? { yaml: true } : {}), outFile: outOf(m), translateScripts: m.translateScripts !== false,
      ...(m.format === 'postman' && m.env ? { environments: { list: data.envs, ...(data.globals ? { globals: data.globals } : {}), includeSecrets: !!m.secrets, ...(m.jetbrains ? { jetbrains: true } : {}) } } : {}),
      ...(m.format && m.format !== 'postman' ? { envValues: data.envValues, history: data.history, ...(orig.doc ? { original: orig.doc } : {}) } : {}),
    });
    panel.webview.onDidReceiveMessage(async (m: Msg) => {
      try {
        if (m.type === 'ready') void panel.webview.postMessage({ type: 'state', name, items, out: join(ws, 'exports', `${name}.${EXT('postman', false)}`) });
        else if (m.type === 'cancel') finish(undefined);
        else if (m.type === 'browse') {
          const pick = await vscode.window.showSaveDialog({ title: 'Save export as', defaultUri: vscode.Uri.file(outOf(m)) });
          if (pick) void panel.webview.postMessage({ type: 'out', out: pick.fsPath });
        } else if (m.type === 'preview') {
          try {
            const built = buildExport(name, files.filter((f) => includeSelected(new Set(m.selected ?? []))(f.path)), optionsOf(m));
            void panel.webview.postMessage({ type: 'preview', seq: m.seq, text: previewText(built.out[0].content), requests: built.requests, skipped: built.skipped.length, files: built.out.length, warnings: [...built.warnings, ...(m.format !== 'postman' && orig.warning ? [orig.warning] : [])] });
          } catch (e) {
            log().error(`export.preview - ${errMsg(e)}`); // pesan tampil di dialog; detail ada di output channel
            void panel.webview.postMessage({ type: 'preview', seq: m.seq, error: errMsg(e) });
          }
        } else if (m.type === 'export') {
          const o = optionsOf(m);
          finish({ confirmSecrets: !!(m.env && m.secrets), choice: { format: o.format, ...(o.yaml ? { yaml: true } : {}), outFile: o.outFile, translateScripts: o.translateScripts !== false, include: includeSelected(new Set(m.selected ?? [])), ...(o.environments ? { environments: { includeSecrets: o.environments.includeSecrets, ...(o.environments.jetbrains ? { jetbrains: true } : {}) } } : {}) } });
        }
      } catch (e) {
        reportError(`exportDialog.${m.type}`, e, `http.me: ${errMsg(e)}`);
      }
    });
    panel.onDidDispose(() => finish(undefined));
  });
}
