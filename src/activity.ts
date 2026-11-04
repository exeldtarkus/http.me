// status bar request berjalan + Quick Pick Cancel (lem tipis VS Code; teks di runningStatus.ts)
import * as vscode from 'vscode';
import { onRunnerChange, REQUEST_VIEW, runner } from './requestEditor';
import { runningItems, runningText } from './runningStatus';

type Item = vscode.QuickPickItem & { id: number };
const CANCEL_ALL: Item = { id: -1, label: '$(close-all) Cancel All', description: 'Cancel every running and queued request' };
const cancelButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Cancel' };

/** Quick Pick: ✕ per request (berjalan / antre) + Cancel All; pilih request = buka tab-nya */
function showRunning(): void {
  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = 'Running requests: ✕ cancels one, Cancel All cancels everything';
  const refresh = () => {
    const jobs = runner.jobs();
    if (!jobs.length) return qp.hide();
    qp.items = [CANCEL_ALL, ...runningItems(jobs, Date.now()).map((i) => ({ ...i, buttons: [cancelButton] }))];
  };
  const sub = onRunnerChange(refresh);
  qp.onDidTriggerItemButton((e) => runner.cancelJob(e.item.id));
  qp.onDidAccept(() => {
    const pick = qp.selectedItems[0];
    qp.hide();
    if (pick === CANCEL_ALL || pick?.id === -1) return void runner.cancelAll();
    const job = runner.jobs().find((j) => j.id === pick?.id);
    if (job) void vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(job.key), REQUEST_VIEW);
  });
  qp.onDidHide(() => { sub.dispose(); qp.dispose(); });
  refresh();
  qp.show();
}

export function registerActivity(): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('httpme.running', vscode.StatusBarAlignment.Left, 50);
  item.name = 'http.me Running Requests';
  item.tooltip = 'Click to cancel running requests';
  item.command = 'httpme.showRunning';
  let timer: ReturnType<typeof setInterval> | undefined;
  // timer detik hanya hidup selama ada request berjalan (idle = tanpa timer)
  const update = () => {
    const text = runningText(runner.jobs(), Date.now());
    if (!text) {
      item.hide();
      clearInterval(timer);
      timer = undefined;
      return;
    }
    item.text = text;
    item.show();
    timer ??= setInterval(update, 1000);
  };
  return vscode.Disposable.from(
    item,
    onRunnerChange(update),
    vscode.commands.registerCommand('httpme.showRunning', showRunning),
    vscode.commands.registerCommand('httpme.cancelAllRequests', () => runner.cancelAll()),
    new vscode.Disposable(() => clearInterval(timer)),
  );
}
