// lem VS Code untuk backup otomatis History + request sementara (tab untitled) ke <workspace>/exports/{history,temp}-backup/ dan command Import
import * as vscode from 'vscode';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { fingerprint, importHistoryItems, parseBackup, shouldBackup, writeBackup, type BackupKind, type BackupState } from './backup';
import { listHistory } from './history';
import { newRequest } from './httpEditor';
import { EXPORTS_DIR } from './exportCommand';
import { errMsg, errorLine } from './log';
import { log, reportError } from './output';

const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const dirOf = (kind: BackupKind) => root() && join(root()!, EXPORTS_DIR, `${kind}-backup`);
const stateKey = (kind: BackupKind) => `httpme.backup.${kind}`;

/** request sementara = tab New Request (untitled .http) yang belum di-Save */
const tempItems = () => vscode.workspace.textDocuments
  .filter((d) => d.uri.scheme === 'untitled' && d.uri.path.endsWith('.http') && d.getText().trim() !== '')
  .map((d) => ({ name: d.uri.path.split('/').pop() ?? '', text: d.getText() }));

/** cek kedua jenis; backup hanya bila ada perubahan dan (hari baru / tumbuh >= batas). Dikembalikan: file yang ditulis (itest) */
export async function backupNow(historyDir: string, memento: vscode.Memento, now = Date.now()): Promise<string[]> {
  const out: string[] = [];
  for (const kind of ['history', 'temp'] as const) {
    const dir = dirOf(kind);
    if (!dir) continue; // tanpa workspace tidak ada exports/
    try {
      const items: unknown[] = kind === 'history' ? await listHistory(historyDir) : tempItems();
      const cur = fingerprint(items);
      const prev = memento.get<BackupState>(stateKey(kind));
      if (!shouldBackup(prev, cur, now)) continue;
      out.push(await writeBackup(dir, kind, items, now));
      await memento.update(stateKey(kind), { at: now, ...cur } satisfies BackupState);
    } catch (e) {
      log().error(errorLine(`backup.${kind}`, e));
    }
  }
  return out;
}

/** command Import: pilih file backup (History / temp), isinya digabung ke History atau dibuka sebagai tab New Request */
async function importBackup(historyDir: string): Promise<void> {
  const base = dirOf('history') ? vscode.Uri.file(join(root()!, EXPORTS_DIR)) : undefined;
  const [pick] = (await vscode.window.showOpenDialog({ defaultUri: base, canSelectMany: false, filters: { 'http.me backup': ['json'] }, openLabel: 'Import Backup', title: 'Import History or Temp Backup' })) ?? [];
  if (!pick) return;
  const b = parseBackup(await fs.readFile(pick.fsPath, 'utf8'));
  if (b.kind === 'history') {
    const r = await importHistoryItems(historyDir, b.items);
    return void vscode.window.showInformationMessage(`History imported: ${r.added} added, ${r.skipped} already present${r.invalid ? `, ${r.invalid} invalid` : ''}.`);
  }
  let n = 0;
  for (const x of b.items) {
    const text = (x as { text?: unknown })?.text;
    if (typeof text !== 'string') continue;
    await newRequest(undefined, text);
    n++;
  }
  void vscode.window.showInformationMessage(`Temp requests imported: ${n} opened as New Request tabs.`);
}

export function registerBackup(ctx: vscode.ExtensionContext, historyDir: string): vscode.Disposable {
  const tick = () => void backupNow(historyDir, ctx.globalState).catch((e) => log().error(errorLine('backup.tick', e)));
  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, 60 * 60 * 1000);
  return vscode.Disposable.from(
    { dispose: () => { clearTimeout(first); clearInterval(timer); } },
    vscode.commands.registerCommand('httpme.importBackup', () => importBackup(historyDir).catch((e) => reportError('importBackup', e, `Import failed: ${errMsg(e)}`))),
  );
}
