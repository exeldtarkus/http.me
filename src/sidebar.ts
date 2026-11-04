// sidebar http.me: satu TreeView native, isi berganti per mode (Collections / Environments / Open). Logika murni di sidebarModel.ts.
import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  arrangeOpen, filterFiles, folderChildren, modeOf, moveInOrder, openChildren, requestSummary, UNTITLED, viewTitle,
  type OpenTab, type RequestSummary, type SidebarMode,
} from './sidebarModel';
import { createFolder, dropKeepIfUsed, duplicateFile, KEEP_FILE, siblingName } from './store';
import { splitBlocks, parseRequest } from './httpFile';
import { toCurl } from './curl';
import { newRequest, REQUEST_VIEW } from './httpEditor';
import { errMsg, errorLine } from './log';
import { log, reportError } from './output';
import type { Environments } from './envState';
import { ENV_DIR } from './environments';

export const VIEW_ID = 'httpme.sidebar';
const MODE_KEY = 'sidebar.mode';
const FLAT_KEY = 'collections.flat';
const OPEN_FLAT_KEY = 'open.flat';
const OPEN_ORDER = 'open.order';
const OPEN_PINNED = 'open.pinned';
const TREE_MIME = 'application/vnd.code.tree.httpme.sidebar';
// shortcut: maksimal 5000 file .http di-scan, naikkan / tambah paging bila ada workspace yang lebih besar
const MAX_FILES = 5000;

type Folder = { kind: 'folder'; root: vscode.WorkspaceFolder; rel: string };
type File = { kind: 'file'; uri: vscode.Uri };
type Empty = { kind: 'empty'; folder: Folder; what: 'label' | 'addRequest' | 'addFolder' };
type OFolder = { kind: 'ofolder'; rel: string; dirty: boolean };
type OUntitled = { kind: 'ountitled'; count: number; dirty: boolean };
type OTab = { kind: 'otab'; tab: OpenTab & { pinned: boolean; viewType?: string } };
type ENone = { kind: 'enone' };
type Env = { kind: 'env'; name: string };
type EGlobals = { kind: 'eglobals' };
type EEmpty = { kind: 'eempty'; what: 'label' | 'create' };
export type Node = Folder | File | Empty | OFolder | OUntitled | OTab | ENone | Env | EGlobals | EEmpty;

const METHOD_COLOR: Record<string, string> = {
  GET: 'charts.green', POST: 'charts.yellow', PUT: 'charts.blue', PATCH: 'charts.purple', DELETE: 'charts.red',
  HEAD: 'terminal.ansiCyan', OPTIONS: 'terminal.ansiMagenta', QUERY: 'terminal.ansiBrightCyan',
};
const exists = (u: vscode.Uri) => Promise.resolve(vscode.workspace.fs.stat(u)).then(() => true, () => false); // stat gagal = belum ada (bukan error)
const folderUri = (f: Folder) => (f.rel ? vscode.Uri.joinPath(f.root.uri, f.rel) : f.root.uri);
const multiRoot = () => (vscode.workspace.workspaceFolders?.length ?? 0) > 1;

/** file http.me yang ikut tampilan Open: .http, script pre/post-request, file Environment */
const isHttpmeFile = (u: vscode.Uri) =>
  /\.http$/i.test(u.path) || /(^|\/)(pre|post)-request\.js$/i.test(u.path) || /\/\.httpme\/environments\/[^/]+\.json$/i.test(u.path);

export class Sidebar implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  private changed = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly dragMimeTypes = [TREE_MIME, 'text/uri-list'];
  readonly dropMimeTypes = [TREE_MIME, 'text/uri-list'];
  view!: vscode.TreeView<Node>;
  private scan: Promise<{ files: vscode.Uri[]; keep: vscode.Uri[] }> | undefined;
  private summaries = new Map<string, { mtime: number; s: RequestSummary }>();
  private filter = '';
  private onlyUnsaved = false;

  constructor(private state: vscode.Memento, private envs: Environments) {}

  get mode(): SidebarMode { return modeOf(this.state.get(MODE_KEY)); }
  private get flat(): boolean { return this.state.get<boolean>(this.mode === 'open' ? OPEN_FLAT_KEY : FLAT_KEY, false); }

  /** ganti mode: context key (ikon aktif di title bar), judul view, isi tree; diingat per workspace */
  async setMode(mode: SidebarMode): Promise<void> {
    await this.state.update(MODE_KEY, mode);
    await this.applyContext();
    this.changed.fire();
  }
  async toggleFlat(): Promise<void> {
    await this.state.update(this.mode === 'open' ? OPEN_FLAT_KEY : FLAT_KEY, !this.flat);
    await this.applyContext();
    this.changed.fire();
  }
  async applyContext(): Promise<void> {
    const m = this.mode;
    await vscode.commands.executeCommand('setContext', 'httpme.sidebarMode', m);
    await vscode.commands.executeCommand('setContext', 'httpme.sidebarFlat', this.flat);
    await vscode.commands.executeCommand('setContext', 'httpme.openOnlyUnsaved', this.onlyUnsaved);
    await vscode.commands.executeCommand('setContext', 'httpme.collectionsFiltered', !!this.filter);
    if (this.view) {
      this.view.title = viewTitle(m);
      this.updateDescription();
    }
  }

  /** scan ulang (watcher / perubahan file); tampilan Open digambar ulang tanpa scan */
  refresh(): void { this.scan = undefined; this.changed.fire(); }
  redraw(): void { this.updateDescription(); this.changed.fire(); }

  async setFilter(f: string): Promise<void> {
    this.filter = f.trim();
    await this.applyContext();
    this.changed.fire();
  }
  async setOnlyUnsaved(v: boolean): Promise<void> {
    this.onlyUnsaved = v;
    await this.applyContext();
    this.changed.fire();
  }

  private updateDescription(): void {
    const tabs = this.openTabs();
    const unsaved = tabs.filter((t) => t.dirty).length;
    this.view.badge = unsaved ? { value: unsaved, tooltip: `${unsaved} unsaved request${unsaved === 1 ? '' : 's'}` } : undefined;
    this.view.description = this.mode === 'open' ? `${this.onlyUnsaved ? 'Unsaved' : 'Open'} (${this.onlyUnsaved ? unsaved : tabs.length})`
      : this.mode === 'collections' && this.filter ? `Filter: ${this.filter}` : undefined;
  }

  // ---------- Collections ----------
  list(): Promise<{ files: vscode.Uri[]; keep: vscode.Uri[] }> {
    if (!this.scan) {
      // selama scan: progress di view + pesan "Scanning…" (viewsWelcome)
      void vscode.commands.executeCommand('setContext', 'httpme.scanning', true);
      const run = Promise.all([vscode.workspace.findFiles('**/*.http', undefined, MAX_FILES), vscode.workspace.findFiles(`**/${KEEP_FILE}`, undefined, MAX_FILES)])
        .then(([files, keep]) => ({
          files: files.filter((u) => !u.path.includes('/node_modules/')).sort((a, b) => a.path.localeCompare(b.path)),
          keep: keep.filter((u) => !u.path.includes('/node_modules/')),
        }), (e: unknown) => {
          log().error(errorLine('Sidebar.list', e));
          return { files: [], keep: [] };
        });
      this.scan = run;
      void vscode.window.withProgress({ location: { viewId: VIEW_ID } }, () => run)
        .then(() => vscode.commands.executeCommand('setContext', 'httpme.scanning', false));
    }
    return this.scan;
  }

  /** method / host / judul file (dibaca saat ditampilkan, di-cache per mtime) */
  async summary(uri: vscode.Uri): Promise<RequestSummary> {
    const key = uri.toString();
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const hit = this.summaries.get(key);
      if (hit && hit.mtime === stat.mtime) return hit.s;
      const s = requestSummary(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
      this.summaries.set(key, { mtime: stat.mtime, s });
      return s;
    } catch (e) {
      log().error(errorLine(`Sidebar.summary ${uri.fsPath}`, e));
      return { method: undefined, host: '', url: '', title: undefined, count: 0 };
    }
  }

  private relOf(root: vscode.WorkspaceFolder, u: vscode.Uri): string { return path.posix.relative(root.uri.path, u.path); }

  /** file yang lolos filter (nama, method, URL) */
  private async filtered(files: vscode.Uri[]): Promise<vscode.Uri[]> {
    if (!this.filter) return files;
    const items = await Promise.all(files.map(async (uri) => {
      const s = await this.summary(uri);
      return { uri, path: vscode.workspace.asRelativePath(uri, multiRoot()), method: s.method, url: s.url };
    }));
    return filterFiles(items, this.filter).map((i) => i.uri);
  }

  private async collectionChildren(n?: Node): Promise<Node[]> {
    if (n?.kind === 'file' || n?.kind === 'empty') return [];
    const { files: all, keep } = await this.list();
    const files = await this.filtered(all);
    const roots = vscode.workspace.workspaceFolders ?? [];
    if (this.flat) return n ? [] : files.map((uri) => ({ kind: 'file', uri }));
    if (!n && roots.length > 1) return roots.map((root) => ({ kind: 'folder', root, rel: '' }));
    const folder = n as Folder | undefined;
    const root = folder?.root ?? roots[0];
    if (!root) return [];
    const inRoot = (u: vscode.Uri) => vscode.workspace.getWorkspaceFolder(u) === root;
    const rel = files.filter(inRoot).map((u) => this.relOf(root, u));
    const keepDirs = this.filter ? [] : keep.filter(inRoot).map((u) => path.posix.dirname(this.relOf(root, u))).filter((d) => d !== '.');
    const kids = folderChildren(rel, keepDirs, folder?.rel ?? '', false);
    const out: Node[] = [
      ...kids.folders.map((r): Folder => ({ kind: 'folder', root, rel: r })),
      ...kids.files.map((r): File => ({ kind: 'file', uri: vscode.Uri.joinPath(root.uri, r) })),
    ];
    // folder kosong: pesan + Add request / Add folder
    if (folder && folder.rel && !out.length && !this.filter) {
      return (['label', 'addRequest', 'addFolder'] as const).map((what): Empty => ({ kind: 'empty', folder, what }));
    }
    return out;
  }

  // ---------- Open ----------
  /** tab http.me yang terbuka (satu per uri), urut pin / drag */
  openTabs(): (OpenTab & { pinned: boolean; viewType?: string })[] {
    const seen = new Map<string, OpenTab & { viewType?: string }>();
    for (const t of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
      const input = t.input;
      const uri = input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
      if (!uri || !isHttpmeFile(uri) || seen.has(uri.toString())) continue;
      seen.set(uri.toString(), {
        uri: uri.toString(), rel: uri.scheme === 'untitled' ? path.posix.basename(uri.path) : vscode.workspace.asRelativePath(uri, multiRoot()),
        untitled: uri.scheme === 'untitled', dirty: t.isDirty, viewType: input instanceof vscode.TabInputCustom ? input.viewType : undefined,
      });
    }
    return arrangeOpen([...seen.values()], this.state.get<string[]>(OPEN_ORDER, []), this.state.get<string[]>(OPEN_PINNED, []));
  }

  private openChildrenOf(n?: Node): Node[] {
    if (n && n.kind !== 'ofolder' && n.kind !== 'ountitled') return [];
    const tabs = this.openTabs();
    const parent = n?.kind === 'ountitled' ? UNTITLED : n?.kind === 'ofolder' ? n.rel : '';
    const kids = openChildren(tabs, parent, this.flat, this.onlyUnsaved);
    return [
      ...kids.folders.map((f): OFolder => ({ kind: 'ofolder', rel: f.rel, dirty: f.dirty })),
      ...(kids.untitled ? [{ kind: 'ountitled', count: kids.untitled.count, dirty: kids.untitled.dirty } as OUntitled] : []),
      ...kids.files.map((tab): OTab => ({ kind: 'otab', tab })),
    ];
  }

  // ---------- Environments ----------
  private async environmentChildren(n?: Node): Promise<Node[]> {
    if (n) return [];
    const names = await this.envs.names();
    const list: Node[] = names.length ? names.map((name): Env => ({ kind: 'env', name }))
      : [{ kind: 'eempty', what: 'label' }, { kind: 'eempty', what: 'create' }];
    return [{ kind: 'enone' }, ...list, { kind: 'eglobals' }];
  }

  /** jumlah NULL (nilai belum diisi, termasuk secret yang belum ada di SecretStorage) */
  private async nullCount(name: string): Promise<number | undefined> {
    try {
      return [...(await this.envs.values(name)).values()].filter((v) => v === null).length;
    } catch (e) {
      log().error(errorLine(`Sidebar.nullCount ${name}`, e));
      return undefined;
    }
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (this.mode === 'environments') return this.environmentChildren(n);
    if (this.mode === 'open') return this.openChildrenOf(n);
    return this.collectionChildren(n);
  }

  /** induk node untuk TreeView.reveal (Open and Reveal) */
  getParent(n: Node): Node | undefined {
    if (n.kind === 'empty') return n.folder;
    if (n.kind !== 'file' && n.kind !== 'folder') return undefined;
    if (this.flat) return undefined;
    const root = n.kind === 'folder' ? n.root : vscode.workspace.getWorkspaceFolder(n.uri);
    if (!root) return undefined;
    const rel = n.kind === 'folder' ? n.rel : this.relOf(root, n.uri);
    if (!rel) return undefined;
    const up = path.posix.dirname(rel);
    if (up === '.') return multiRoot() ? { kind: 'folder', root, rel: '' } : undefined;
    return { kind: 'folder', root, rel: up };
  }

  async getTreeItem(n: Node): Promise<vscode.TreeItem> {
    switch (n.kind) {
      case 'folder': {
        const uri = folderUri(n);
        return Object.assign(new vscode.TreeItem(uri, this.filter ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed), {
          id: `folder:${uri.toString()}`,
          label: n.rel ? path.posix.basename(n.rel) : n.root.name,
          contextValue: n.rel ? 'httpmeFolder' : 'httpmeRoot',
        });
      }
      case 'file': {
        const s = await this.summary(n.uri);
        const name = path.posix.basename(n.uri.path).replace(/\.http$/i, '');
        const dir = path.posix.dirname(vscode.workspace.asRelativePath(n.uri, multiRoot()));
        const what = s.count > 1 ? `${s.count} requests` : [s.method, s.host].filter(Boolean).join(' ');
        return Object.assign(new vscode.TreeItem(n.uri), {
          id: `file:${n.uri.toString()}`,
          label: name,
          description: [this.flat && dir !== '.' ? dir : '', what].filter(Boolean).join(' · '),
          tooltip: `${vscode.workspace.asRelativePath(n.uri, multiRoot())}${s.title ? `\n${s.title}` : ''}${s.url ? `\n${s.method} ${s.url}` : ''}`,
          iconPath: s.count > 1 ? new vscode.ThemeIcon('list-unordered') : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(METHOD_COLOR[s.method ?? ''] ?? 'foreground')),
          contextValue: 'httpmeFile',
          command: { command: 'httpme.openRequest', title: 'Open', arguments: [n.uri] },
        });
      }
      case 'empty': {
        const top = !n.folder.rel.includes('/');
        if (n.what === 'label') {
          return Object.assign(new vscode.TreeItem(top ? 'Collection is empty' : 'Folder is empty'), {
            description: 'Add a request or folder to structure your API workflow.', iconPath: new vscode.ThemeIcon('info'), contextValue: 'httpmeEmpty',
          });
        }
        const add = n.what === 'addRequest';
        return Object.assign(new vscode.TreeItem(add ? 'Add request' : 'Add folder'), {
          iconPath: new vscode.ThemeIcon(add ? 'add' : 'new-folder'), contextValue: 'httpmeEmpty',
          command: { command: add ? 'httpme.newRequestIn' : 'httpme.newFolder', title: add ? 'Add request' : 'Add folder', arguments: [n.folder] },
        });
      }
      case 'ofolder':
        return Object.assign(new vscode.TreeItem(path.posix.basename(n.rel), vscode.TreeItemCollapsibleState.Expanded), {
          id: `ofolder:${n.rel}`, iconPath: vscode.ThemeIcon.Folder, description: n.dirty ? '●' : undefined, contextValue: 'httpmeOpenFolder',
        });
      case 'ountitled':
        return Object.assign(new vscode.TreeItem('Untitled', vscode.TreeItemCollapsibleState.Expanded), {
          id: 'ountitled', iconPath: new vscode.ThemeIcon('new-file'), description: `${n.count}${n.dirty ? ' ●' : ''}`, contextValue: 'httpmeOpenFolder',
        });
      case 'enone': {
        const on = this.envs.active === undefined;
        return Object.assign(new vscode.TreeItem({ label: 'No Environment', highlights: on ? [[0, 14]] : [] }), {
          id: 'enone', iconPath: new vscode.ThemeIcon(on ? 'check' : 'circle-slash'), description: on ? 'active' : undefined,
          tooltip: 'Send requests without an Environment', contextValue: 'httpmeNoEnvironment',
          command: { command: 'httpme.setActiveEnvironment', title: 'Set Active', arguments: [undefined] },
        });
      }
      case 'env': {
        const on = this.envs.active === n.name;
        const nulls = await this.nullCount(n.name);
        return Object.assign(new vscode.TreeItem({ label: n.name, highlights: on ? [[0, n.name.length]] : [] }), {
          id: `env:${n.name}`, iconPath: new vscode.ThemeIcon(on ? 'check' : 'symbol-namespace'),
          description: [on ? 'active' : '', nulls ? `${nulls} NULL` : nulls === undefined ? 'invalid file' : ''].filter(Boolean).join(' · ') || undefined,
          tooltip: `${ENV_DIR}/${n.name}.json${nulls ? `\n${nulls} variable${nulls === 1 ? '' : 's'} without a value (NULL)` : ''}`,
          contextValue: on ? 'httpmeEnvironmentActive' : 'httpmeEnvironment',
          command: { command: 'httpme.openEnvironment', title: 'Open', arguments: [n.name] },
        });
      }
      case 'eglobals':
        return Object.assign(new vscode.TreeItem('Globals'), {
          id: 'eglobals', iconPath: new vscode.ThemeIcon('globe'), description: 'every Environment', tooltip: 'Variables for every Environment, stored on this computer',
          contextValue: 'httpmeGlobals', command: { command: 'httpme.openGlobals', title: 'Open Globals' },
        });
      case 'eempty':
        return n.what === 'label'
          ? Object.assign(new vscode.TreeItem('No environments'), { iconPath: new vscode.ThemeIcon('info'), description: 'dev, uat, prod… with the same keys', contextValue: 'httpmeEmpty' })
          : Object.assign(new vscode.TreeItem('Create Environment'), { iconPath: new vscode.ThemeIcon('add'), contextValue: 'httpmeEmpty', command: { command: 'httpme.newEnvironment', title: 'Create Environment' } });
      case 'otab': {
        const uri = vscode.Uri.parse(n.tab.uri);
        return Object.assign(new vscode.TreeItem(uri), {
          id: `otab:${n.tab.uri}`,
          label: path.posix.basename(uri.path),
          description: [n.tab.dirty ? '●' : '', this.flat && !n.tab.untitled ? path.posix.dirname(n.tab.rel).replace(/^\.$/, '') : ''].filter(Boolean).join(' '),
          iconPath: n.tab.pinned ? new vscode.ThemeIcon('pinned') : undefined,
          tooltip: `${n.tab.rel}${n.tab.dirty ? ' (unsaved)' : ''}`,
          contextValue: `httpmeOpenTab${n.tab.pinned ? 'Pinned' : ''}${n.tab.untitled ? 'Untitled' : ''}`,
          command: { command: 'httpme.focusTab', title: 'Open', arguments: [n.tab.uri, n.tab.viewType] },
        });
      }
    }
  }

  // ---------- drag & drop ----------
  handleDrag(nodes: readonly Node[], data: vscode.DataTransfer): void {
    const uris = nodes.map((n) => (n.kind === 'file' ? n.uri : n.kind === 'folder' && n.rel ? folderUri(n) : n.kind === 'otab' ? vscode.Uri.parse(n.tab.uri) : undefined))
      .filter((u): u is vscode.Uri => !!u);
    data.set(TREE_MIME, new vscode.DataTransferItem(uris.map(String)));
    data.set('text/uri-list', new vscode.DataTransferItem(uris.map(String).join('\r\n')));
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    const own = data.get(TREE_MIME)?.value as string[] | undefined;
    const list = own ?? (await data.get('text/uri-list')?.asString())?.split(/\r?\n/).filter(Boolean) ?? [];
    const uris = list.map((s) => vscode.Uri.parse(s));
    if (this.mode === 'open') {
      // urutan Open: item dipindah sebelum target
      const shown = this.openTabs().map((t) => t.uri);
      const to = target?.kind === 'otab' ? target.tab.uri : undefined;
      await this.state.update(OPEN_ORDER, moveInOrder(shown, uris.map(String), to));
      return this.redraw();
    }
    const dest = target?.kind === 'folder' ? folderUri(target) : target?.kind === 'file' ? vscode.Uri.joinPath(target.uri, '..')
      : target?.kind === 'empty' ? folderUri(target.folder) : vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!dest) return;
    await moveInto(uris.filter((u) => own || /\.http$/i.test(u.path)), dest);
    this.refresh();
  }
}

/** pindah file / folder ke folder lain lewat WorkspaceEdit (tab yang terbuka ikut pindah) */
export async function moveInto(uris: vscode.Uri[], dest: vscode.Uri): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  for (const u of uris) {
    const to = vscode.Uri.joinPath(dest, path.posix.basename(u.path));
    if (to.toString() === u.toString()) continue;
    if (dest.path === u.path || dest.path.startsWith(`${u.path}/`)) throw new Error(`${path.posix.basename(u.path)} cannot be moved into itself`);
    if (await exists(to)) throw new Error(`${path.posix.basename(u.path)} already exists in ${path.posix.basename(dest.path)}`);
    edit.renameFile(u, to);
  }
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error('The files could not be moved');
  if (dest.scheme === 'file') await dropKeepIfUsed(dest.fsPath);
}

// ---------- commands ----------
type Arg = Node | vscode.Uri | undefined;
const uriOf = (a: Arg): vscode.Uri | undefined =>
  a instanceof vscode.Uri ? a : a?.kind === 'file' ? a.uri : a?.kind === 'folder' ? folderUri(a) : a?.kind === 'otab' ? vscode.Uri.parse(a.tab.uri) : undefined;

/** folder tujuan aksi: node folder, folder file, atau collectionsRoot / root workspace */
async function targetDir(a: Arg): Promise<vscode.Uri | undefined> {
  if (a && !(a instanceof vscode.Uri) && a.kind === 'folder') return folderUri(a);
  if (a && !(a instanceof vscode.Uri) && a.kind === 'empty') return folderUri(a.folder);
  const u = uriOf(a);
  if (u) return (await vscode.workspace.fs.stat(u)).type === vscode.FileType.Directory ? u : vscode.Uri.joinPath(u, '..');
  const roots = vscode.workspace.workspaceFolders ?? [];
  const root = roots.length > 1 ? await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Create in' }) : roots[0];
  if (!root) return undefined;
  const sub = vscode.workspace.getConfiguration('httpme', root.uri).get<string>('collectionsRoot', '').trim().replace(/^\/+|\/+$/g, '');
  return sub ? vscode.Uri.joinPath(root.uri, sub) : root.uri;
}

/** nama dari input box (atau `input` dari itest), divalidasi + cek bentrok di folder tujuan */
async function askName(title: string, dir: vscode.Uri, isFile: boolean, value = '', input?: string): Promise<string | undefined> {
  input ??= await vscode.window.showInputBox({
    title, value, valueSelection: [0, isFile ? value.replace(/\.http$/i, '').length : value.length],
    validateInput: async (v) => {
      const name = siblingName(v, isFile);
      if (typeof name !== 'string') return v ? name.error : undefined;
      return name !== value && (await exists(vscode.Uri.joinPath(dir, name))) ? `${name} already exists` : undefined;
    },
  });
  if (input === undefined) return undefined;
  const name = siblingName(input, isFile);
  if (typeof name !== 'string') throw new Error(name.error);
  return name;
}

/** buka file dari Collections: 1 request -> panel, multi-request -> editor teks (CodeLens per blok) */
export async function openRequest(uri: vscode.Uri): Promise<void> {
  const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  if (splitBlocks(text).length > 1) await vscode.window.showTextDocument(uri, { preview: true });
  else await vscode.commands.executeCommand('vscode.openWith', uri, REQUEST_VIEW);
}

export function registerSidebar(ctx: vscode.ExtensionContext, envs: Environments): { sidebar: Sidebar; disposable: vscode.Disposable } {
  const sidebar = new Sidebar(ctx.workspaceState, envs);
  const view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: sidebar, dragAndDropController: sidebar, canSelectMany: true, showCollapseAll: true });
  sidebar.view = view;
  void sidebar.applyContext();

  const run = (name: string, fn: (...a: never[]) => unknown) => (...args: never[]) =>
    Promise.resolve().then(() => fn(...args)).catch((e) => reportError(name, e, `http.me: ${errMsg(e)}`));
  const cmd = (id: string, fn: (...a: never[]) => unknown) => vscode.commands.registerCommand(id, run(id, fn));

  // watcher: file .http / .httpmekeep dibuat / dihapus / di-rename dari luar (git pull, Explorer)
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rescan = () => { clearTimeout(timer); timer = setTimeout(() => sidebar.refresh(), 200); };
  const watchers = [vscode.workspace.createFileSystemWatcher('**/*.http'), vscode.workspace.createFileSystemWatcher(`**/${KEEP_FILE}`)];
  for (const w of watchers) { w.onDidCreate(rescan); w.onDidDelete(rescan); w.onDidChange(() => sidebar.redraw()); }

  // Open: ikut tab / dirty / save tanpa polling
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const redrawOpen = () => { clearTimeout(openTimer); openTimer = setTimeout(() => sidebar.redraw(), 100); };

  // Open and Reveal: file aktif disorot di Collections
  const revealActive = async () => {
    if (sidebar.mode !== 'collections' || !view.visible) return;
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined;
    const uri = input?.uri;
    if (!uri || !/\.http$/i.test(uri.path) || uri.scheme !== 'file') return;
    const { files } = await sidebar.list();
    if (files.some((u) => u.toString() === uri.toString())) await view.reveal({ kind: 'file', uri }, { select: true, focus: false, expand: true });
  };

  const disposable = vscode.Disposable.from(
    view, ...watchers, new vscode.Disposable(() => { clearTimeout(timer); clearTimeout(openTimer); }),
    vscode.window.tabGroups.onDidChangeTabs(() => { redrawOpen(); void revealActive().catch((e) => log().error(errorLine('revealActive', e))); }),
    vscode.workspace.onDidChangeTextDocument((e) => { if (isHttpmeFile(e.document.uri)) redrawOpen(); }),
    vscode.workspace.onDidSaveTextDocument(redrawOpen),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sidebar.refresh()),
    envs.onDidChange(() => { if (sidebar.mode === 'environments') sidebar.redraw(); }),

    // mode: ikon berbeda untuk mode aktif (fallback `toggled` yang belum didukung kontribusi extension di VS Code 1.90)
    ...(['collections', 'environments', 'open'] as const).flatMap((m) => {
      const name = m[0].toUpperCase() + m.slice(1);
      return [cmd(`httpme.show${name}`, () => sidebar.setMode(m)), cmd(`httpme.show${name}Active`, () => sidebar.setMode(m))];
    }),
    cmd('httpme.toggleFlat', () => sidebar.toggleFlat()),
    cmd('httpme.toggleFlatOff', () => sidebar.toggleFlat()),
    cmd('httpme.refreshCollections', () => sidebar.refresh()),
    cmd('httpme.filterCollections', async (input?: string) => {
      const f = input ?? await vscode.window.showInputBox({ title: 'Filter Collections', placeHolder: 'Name, method or URL', value: '' });
      if (f !== undefined) await sidebar.setFilter(f);
    }),
    cmd('httpme.clearFilter', () => sidebar.setFilter('')),
    cmd('httpme.add', async () => {
      const pick = await vscode.window.showQuickPick([
        { label: '$(repo) New Collection', id: 'httpme.newCollection' },
        { label: '$(new-folder) New Folder', id: 'httpme.newFolder' },
        { label: '$(add) New Request', id: 'httpme.newRequest' },
        { label: '$(clippy) Import…', description: 'cURL command from the clipboard', id: 'httpme.importFromClipboard' },
      ], { placeHolder: 'Add to Collections' });
      if (pick) await vscode.commands.executeCommand(pick.id, view.selection[0]);
    }),
    cmd('httpme.newCollection', async (_a?: Arg, input?: string) => {
      const dir = await targetDir(undefined);
      if (!dir) return;
      const name = await askName('New Collection', dir, false, '', input);
      if (!name) return;
      await createFolder(dir.fsPath, name);
      sidebar.refresh();
    }),
    cmd('httpme.newFolder', async (a?: Arg, input?: string) => {
      const dir = await targetDir(a);
      if (!dir) return;
      const name = await askName(`New Folder in ${vscode.workspace.asRelativePath(dir, multiRoot())}`, dir, false, '', input);
      if (!name) return;
      await createFolder(dir.fsPath, name);
      sidebar.refresh();
    }),
    cmd('httpme.newRequestIn', async (a?: Arg) => newRequest(await targetDir(a))),
    cmd('httpme.openRequest', (uri: vscode.Uri) => openRequest(uri)),
    cmd('httpme.rename', async (a?: Arg, input?: string) => {
      const uri = uriOf(a ?? view.selection[0]);
      if (!uri) return;
      const isFile = (await vscode.workspace.fs.stat(uri)).type !== vscode.FileType.Directory;
      const dir = vscode.Uri.joinPath(uri, '..');
      const old = path.posix.basename(uri.path);
      const name = await askName(`Rename ${old}`, dir, isFile, old, input);
      if (!name || name === old) return;
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(uri, vscode.Uri.joinPath(dir, name));
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`${old} could not be renamed`);
      sidebar.refresh();
    }),
    cmd('httpme.duplicate', async (a?: Arg) => {
      const uri = uriOf(a ?? view.selection[0]);
      if (!uri) return;
      const copy = await duplicateFile(uri.fsPath);
      sidebar.refresh();
      await openRequest(vscode.Uri.file(copy));
    }),
    cmd('httpme.delete', async (a?: Arg, confirmed?: boolean) => {
      const nodes = a ? [a] : [...view.selection];
      const uris = nodes.map(uriOf).filter((u): u is vscode.Uri => !!u);
      if (!uris.length) return;
      const what = uris.length === 1 ? path.posix.basename(uris[0].path) : `${uris.length} items`;
      if (!confirmed && (await vscode.window.showWarningMessage(`Delete ${what}?`, { modal: true, detail: 'It is moved to the trash.' }, 'Delete')) !== 'Delete') return;
      for (const u of uris) await vscode.workspace.fs.delete(u, { recursive: true, useTrash: true });
      sidebar.refresh();
    }),
    cmd('httpme.revealInExplorer', (a?: Arg) => vscode.commands.executeCommand('revealInExplorer', uriOf(a ?? view.selection[0]))),
    cmd('httpme.copyAsCurl', async (a?: Arg) => {
      const uri = uriOf(a ?? view.selection[0]);
      if (!uri) return;
      const text = (await vscode.workspace.openTextDocument(uri)).getText();
      const blocks = splitBlocks(text);
      const curl = (blocks.length > 1 ? blocks.map((b) => parseRequest(b.text)) : [parseRequest(text)]).map(toCurl).join('\n\n');
      await vscode.env.clipboard.writeText(curl);
      void vscode.window.showInformationMessage(blocks.length > 1 ? `${blocks.length} cURL commands copied.` : 'cURL command copied.');
    }),
    cmd('httpme.moveTo', (uri: vscode.Uri, dest: vscode.Uri) => moveInto([uri], dest).then(() => sidebar.refresh())),

    // Open
    cmd('httpme.openShowUnsaved', () => sidebar.setOnlyUnsaved(true)),
    cmd('httpme.openShowAll', () => sidebar.setOnlyUnsaved(false)),
    cmd('httpme.focusTab', async (uri: string, viewType?: string) => {
      const u = vscode.Uri.parse(uri);
      if (viewType) await vscode.commands.executeCommand('vscode.openWith', u, viewType);
      else await vscode.window.showTextDocument(u, { preview: false });
    }),
    cmd('httpme.saveTab', async (a?: Arg) => { const u = uriOf(a); if (u) await (await vscode.workspace.openTextDocument(u)).save(); }),
    cmd('httpme.revertTab', async (a?: Arg) => {
      const u = uriOf(a);
      if (!u) return;
      await vscode.window.showTextDocument(u, { preview: false });
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }),
    cmd('httpme.closeTab', async (a?: Arg) => {
      const u = uriOf(a)?.toString();
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => (t.input as { uri?: vscode.Uri } | undefined)?.uri?.toString() === u);
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
    }),
    cmd('httpme.pinTab', async (a?: Arg) => {
      const u = uriOf(a)?.toString();
      if (!u) return;
      const pinned = ctx.workspaceState.get<string[]>(OPEN_PINNED, []);
      await ctx.workspaceState.update(OPEN_PINNED, pinned.includes(u) ? pinned : [...pinned, u]);
      sidebar.redraw();
    }),
    cmd('httpme.unpinTab', async (a?: Arg) => {
      const u = uriOf(a)?.toString();
      await ctx.workspaceState.update(OPEN_PINNED, ctx.workspaceState.get<string[]>(OPEN_PINNED, []).filter((x) => x !== u));
      sidebar.redraw();
    }),
    cmd('httpme.revealInCollections', async (a?: Arg) => {
      const u = uriOf(a);
      await sidebar.setMode('collections');
      if (u?.scheme === 'file') await view.reveal({ kind: 'file', uri: u }, { select: true, focus: true, expand: true });
    }),
    cmd('httpme.saveAll', () => vscode.commands.executeCommand('workbench.action.files.saveAll')),
    cmd('httpme.closeAll', () => vscode.commands.executeCommand('workbench.action.closeAllEditors')),
  );
  return { sidebar, disposable };
}
