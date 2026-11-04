// status bar request berjalan + Quick Pick Cancel, status bar History + Quick Pick (lem tipis VS Code; teks di runningStatus.ts)
import * as vscode from 'vscode';
import { newRequest, onRunnerChange, REQUEST_VIEW, runner, sendBlock, sendUri, setHistoryHook } from './httpEditor';
import { historyItems, runningItems, runningText, runningTooltip } from './runningStatus';
import { addHistory, clearHistory, historyEntry, historyId, listHistory, removeHistory, type HistoryEntry } from './history';
import { parseRequest, splitBlocks } from './httpFile';
import { toCurl } from './curl';
import { errMsg, errorLine } from './log';
import { log, reportError } from './output';

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

export type HistoryAction = 'open' | 'send' | 'curl' | 'remove';

/** dokumen asal entri History masih ada (file di disk / untitled yang masih terbuka) */
async function origin(e: HistoryEntry): Promise<vscode.TextDocument | undefined> {
  if (!e.file) return undefined;
  const uri = vscode.Uri.parse(e.file);
  if (uri.scheme === 'untitled') return vscode.workspace.textDocuments.find((d) => d.uri.toString() === e.file);
  const ok = await Promise.resolve(vscode.workspace.fs.stat(uri)).then(() => true, () => false); // file sudah dihapus = buka sebagai untitled
  return ok ? vscode.workspace.openTextDocument(uri) : undefined;
}

/** aksi satu entri History: buka (file asal / untitled .http), Send again, Copy as cURL, Remove */
export async function historyAction(dir: string, id: string, action: HistoryAction): Promise<void> {
  const e = (await listHistory(dir)).find((x) => x.id === id);
  if (!e) return;
  if (action === 'remove') return removeHistory(dir, id);
  if (action === 'curl') {
    await vscode.env.clipboard.writeText(toCurl(parseRequest(e.text)));
    return void vscode.window.showInformationMessage('Copied as cURL (without cookies).');
  }
  const doc = await origin(e);
  const multi = doc ? splitBlocks(doc.getText()).length > 1 : false;
  if (action === 'open') {
    if (!doc) return void (await newRequest(undefined, e.text));
    if (!multi) return void (await vscode.commands.executeCommand('vscode.openWith', doc.uri, REQUEST_VIEW));
    const b = splitBlocks(doc.getText())[e.block ?? 0];
    await vscode.window.showTextDocument(doc, { selection: b ? new vscode.Range(b.start, 0, b.start, 0) : undefined });
    return;
  }
  // Send again: file asal bila masih ada, selain itu tab untitled baru berisi request itu
  if (doc && multi) return sendBlock(doc, e.block ?? 0);
  return sendUri(doc ? doc.uri : await newRequest(undefined, e.text));
}

const BUTTONS: Record<HistoryAction, vscode.QuickInputButton> = {
  open: { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Open' },
  send: { iconPath: new vscode.ThemeIcon('play'), tooltip: 'Send again' },
  curl: { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'Copy as cURL' },
  remove: { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove' },
};
const CLEAR: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Clear all' };

function showHistory(dir: string): void {
  type HItem = vscode.QuickPickItem & { id: string };
  const qp = vscode.window.createQuickPick<HItem>();
  qp.title = 'Request History';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.buttons = [CLEAR];
  const refresh = async () => {
    const items = historyItems(await listHistory(dir), Date.now());
    qp.placeholder = items.length ? 'Open a request · ▶ send again · copy as cURL · remove' : 'No requests yet. Send a request (Ctrl+Enter) and it shows up here.';
    qp.items = items.map((i) => ({ ...i, buttons: [BUTTONS.send, BUTTONS.curl, BUTTONS.remove] }));
  };
  const run = (id: string, a: HistoryAction) => historyAction(dir, id, a).catch((e) => reportError(`history.${a}`, e, `History: ${errMsg(e)}`));
  qp.onDidTriggerItemButton(async (e) => {
    const a = (Object.keys(BUTTONS) as HistoryAction[]).find((k) => BUTTONS[k] === e.button)!;
    if (a !== 'remove') qp.hide();
    await run(e.item.id, a);
    if (a === 'remove') await refresh();
  });
  qp.onDidTriggerButton(async () => {
    const ok = await vscode.window.showWarningMessage('Clear all request history?', { modal: true }, 'Clear All');
    if (ok !== 'Clear All') return;
    await clearHistory(dir).catch((e) => reportError('history.clear', e, `Could not clear history: ${errMsg(e)}`));
    await refresh();
  });
  qp.onDidAccept(() => {
    const pick = qp.selectedItems[0];
    qp.hide();
    if (pick) void run(pick.id, 'open');
  });
  qp.onDidHide(() => qp.dispose());
  qp.busy = true;
  qp.show();
  void refresh().catch((e) => reportError('history.list', e, `Could not read history: ${errMsg(e)}`)).finally(() => { qp.busy = false; });
}

/** status bar saat ini (itest) */
let items: { running: vscode.StatusBarItem; history: vscode.StatusBarItem; visible: boolean } | undefined;
export const statusBar = () => items && {
  running: items.visible ? { text: items.running.text, tooltip: String(items.running.tooltip) } : undefined,
  history: items.history.text,
};

/** dir = globalStorage/httpme-cache/history */
export function registerActivity(dir: string): vscode.Disposable {
  const hist = vscode.window.createStatusBarItem('httpme.history', vscode.StatusBarAlignment.Left, 49);
  hist.name = 'http.me History';
  hist.text = '$(history) History';
  hist.tooltip = 'http.me: request history';
  hist.command = 'httpme.showHistory';
  hist.show();
  let seq = 0;
  // tulis History berurutan: prune tidak balapan dengan tulis berikutnya
  let chain: Promise<void> = Promise.resolve();
  const record = setHistoryHook((x) => {
    const now = Date.now();
    const e = historyEntry({ ...x, id: historyId(now, ++seq), time: now });
    chain = chain.then(() => addHistory(dir, e)).catch((err) => log().error(errorLine('history.add', err)));
  });
  const item = vscode.window.createStatusBarItem('httpme.running', vscode.StatusBarAlignment.Left, 50);
  item.name = 'http.me Running Requests';
  item.command = 'httpme.showRunning';
  let timer: ReturnType<typeof setInterval> | undefined;
  // timer detik hanya hidup selama ada request berjalan (idle = tanpa timer)
  const update = () => {
    const text = runningText(runner.jobs(), Date.now());
    if (items) items.visible = !!text;
    if (!text) {
      item.hide();
      clearInterval(timer);
      timer = undefined;
      return;
    }
    item.text = text;
    item.tooltip = `${runningTooltip(runner.jobs(), Date.now())}\nClick to cancel`;
    item.show();
    timer ??= setInterval(update, 1000);
  };
  items = { running: item, history: hist, visible: false };
  return vscode.Disposable.from(
    item, hist, record,
    vscode.commands.registerCommand('httpme.showHistory', () => showHistory(dir)),
    onRunnerChange(update),
    vscode.commands.registerCommand('httpme.showRunning', showRunning),
    vscode.commands.registerCommand('httpme.cancelAllRequests', () => runner.cancelAll()),
    new vscode.Disposable(() => clearInterval(timer)),
  );
}
