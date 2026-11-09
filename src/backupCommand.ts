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

export type BackupResult = { kind: BackupKind; file: string; count: number };

/** cek kedua jenis; backup hanya bila ada perubahan dan (hari baru / tumbuh >= batas). Dikembalikan: file yang ditulis (+ jumlah item) */
export async function backupNow(historyDir: string, memento: vscode.Memento, now = Date.now(), onStep?: (done: number, total: number) => void): Promise<BackupResult[]> {
  const out: BackupResult[] = [];
  const kinds = ['history', 'temp'] as const;
  for (const [i, kind] of kinds.entries()) {
    onStep?.(i, kinds.length);
    const dir = dirOf(kind);
    if (!dir) continue; // tanpa workspace tidak ada exports/
    try {
      const items: unknown[] = kind === 'history' ? await listHistory(historyDir) : tempItems();
      const cur = fingerprint(items);
      const prev = memento.get<BackupState>(stateKey(kind));
      if (!shouldBackup(prev, cur, now)) continue;
      out.push({ kind, file: await writeBackup(dir, kind, items, now), count: items.length });
      await memento.update(stateKey(kind), { at: now, ...cur } satisfies BackupState);
    } catch (e) {
      log().error(errorLine(`backup.${kind}`, e));
    }
    await new Promise((r) => setImmediate(r)); // beri giliran ke event loop
  }
  onStep?.(kinds.length, kinds.length);
  return out;
}

/** command Import: pilih file backup (History / temp), isinya digabung ke History atau dibuka sebagai tab New Request */
async function importBackup(historyDir: string): Promise<void> {
  const base = dirOf('history') ? vscode.Uri.file(join(root()!, EXPORTS_DIR)) : undefined;
  const [pick] = (await vscode.window.showOpenDialog({ defaultUri: base, canSelectMany: false, filters: { 'http.me backup': ['json'] }, openLabel: 'Import Backup', title: 'Import History or Temp Backup' })) ?? [];
  if (!pick) return;
  const b = parseBackup(await fs.readFile(pick.fsPath, 'utf8'));
  // berjalan di notifikasi dengan progress bar; editor tetap bisa dipakai selama import
  const message = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'http.me: Importing backup' }, async (progress) => {
    const step = (done: number, total: number) => progress.report({ increment: 100 / Math.max(1, total), message: `${done}/${total}` });
    if (b.kind === 'history') {
      const r = await importHistoryItems(historyDir, b.items, step);
      return `History import complete: ${r.added} added, ${r.skipped} already present${r.invalid ? `, ${r.invalid} invalid` : ''}.`;
    }
    let n = 0;
    for (const [i, x] of b.items.entries()) {
      const text = (x as { text?: unknown })?.text;
      if (typeof text === 'string') { await newRequest(undefined, text); n++; }
      step(i + 1, b.items.length);
    }
    return `Temp import complete: ${n} request${n === 1 ? '' : 's'} opened as New Request tabs.`;
  });
  void vscode.window.showInformationMessage(message);
}

export function registerBackup(ctx: vscode.ExtensionContext, historyDir: string): vscode.Disposable {
  let running = false; // tick tidak saling tumpang tindih
  const tick = () => {
    if (running) return;
    running = true;
    // progress di status bar (tidak memotong kerja user); notifikasi hanya bila ada file yang ditulis
    void vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'http.me: Backing up History and temp requests' }, async (progress) => {
      const done = await backupNow(historyDir, ctx.globalState, Date.now(), (d, total) => progress.report({ increment: 100 / total, message: `${d}/${total}` }));
      if (done.length) void vscode.window.showInformationMessage(`http.me backup complete: ${done.map((r) => `${r.kind} (${r.count})`).join(', ')} saved to ${EXPORTS_DIR}/.`);
    }).then(undefined, (e) => log().error(errorLine('backup.tick', e))).then(() => { running = false; });
  };
  const first = setTimeout(tick, 10_000);
  const timer = setInterval(tick, 60 * 60 * 1000);
  return vscode.Disposable.from(
    { dispose: () => { clearTimeout(first); clearInterval(timer); } },
    vscode.commands.registerCommand('httpme.importBackup', () => importBackup(historyDir).catch((e) => reportError('importBackup', e, `Import failed: ${errMsg(e)}`))),
  );
}
