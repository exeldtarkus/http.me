// bar "Back to Dashboard" di dalam webview request / Environment / All Environments + ikon di title bar (lem VS Code; state murni di backBarState.ts)
import * as vscode from 'vscode';
import { OpenedSet } from './backBarState';

const changed = new vscode.EventEmitter<void>();
const opened = new OpenedSet((list) => {
  void vscode.commands.executeCommand('setContext', 'httpme.dashboardOpened', list); // ikon panah di title bar editor
  changed.fire();
});

/** key All Environments (webview, bukan file) */
export const COMPARE_KEY = 'httpme:compare';

/** editor ini dibuka dari Dashboard: tombol Back tampil (file: pakai fsPath) */
export function markOpened(key: string | vscode.Uri | undefined): void {
  const k = typeof key === 'string' ? key : key?.scheme === 'file' ? key.fsPath : undefined;
  if (k) opened.add(k);
}

/** panel webview ditutup: tombol Back tidak ikut ke pembukaan berikutnya dari tempat lain */
export const forgetOpened = (key: string): void => opened.delete(key);

/** tab yang sudah ditutup dilepas dari daftar */
export function pruneOpened(): void {
  const open = new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => (t.input as { uri?: vscode.Uri } | undefined)?.uri?.fsPath).filter((x): x is string => !!x)));
  open.add(COMPARE_KEY); // tab webview tanpa uri: dilepas lewat onDidDispose panelnya
  opened.prune(open);
}

/** pasang di panel webview: kirim status bar saat siap / berubah, tangani klik Back */
export function attachBackBar(panel: vscode.WebviewPanel, key: () => string | undefined): vscode.Disposable {
  const post = () => { const k = key(); void panel.webview.postMessage({ type: 'backBar', on: !!k && opened.has(k) }); };
  return vscode.Disposable.from(
    panel.webview.onDidReceiveMessage((m: { type?: string }) => {
      if (m.type === 'ready') post();
      else if (m.type === 'backToDashboard') void vscode.commands.executeCommand('httpme.openDashboard');
    }),
    changed.event(post),
  );
}
