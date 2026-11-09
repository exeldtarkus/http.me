// sidebar http.me: 4 section TreeView native (Collections, Environments, Open, Cookies) seperti Explorer VS Code,
// tiap section punya judul & tombol aksinya sendiri. Satu class Sidebar per section (mode tetap). Logika murni di sidebarModel.ts.
import * as vscode from 'vscode';
import { deleteWithFallback } from './trash';
import { reimport } from './importCommand';
import { exportCollection } from './exportCommand';
import { importableFiles } from './importFetch';
import * as path from 'node:path';
import {
  arrangeOpen, busyTracker, closeTargets, unsavedPrompt, filterFiles, folderChildren, moveInOrder, openChildren, requestSummary, UNTITLED,
  type OpenTab, type RequestSummary, type SidebarMode,
} from './sidebarModel';
import { applyOrder, ORDER_FILE, readOrder, type OrderMap } from './collectionOrder';
import { reorderChild } from './orderCommand';
import { createFolder, dropKeepIfUsed, duplicateFile, KEEP_FILE, siblingName } from './store';
import { splitBlocks, parseRequest } from './httpFile';
import { toCurl } from './curl';
import { toCurlCmd, toPowerShell } from './shellDialect';
import { resolveRequest } from './vars';
import { newRequest, REQUEST_VIEW } from './httpEditor';
import { errMsg, errorLine } from './log';
import { log, reportError } from './output';
import type { Environments } from './envState';
import type { Cookies } from './cookies';
import type { Cookie } from './cookieJar';
import { maskCookie } from './httpEditor';
import { ENV_DIR } from './environments';

export const VIEW_ID = 'httpme.sidebar';
/** id view per section (Collections tetap memakai id lama) */
export const VIEW_IDS: Record<SidebarMode, string> = { collections: VIEW_ID, environments: 'httpme.environments', open: 'httpme.open', cookies: 'httpme.cookies' };
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
type CEnv = { kind: 'cenv'; env: string };
type CDomain = { kind: 'cdomain'; env: string; domain: string };
type CCookie = { kind: 'cookie'; env: string; cookie: Cookie };
type CEmpty = { kind: 'cempty' };
export type Node = Folder | File | Empty | OFolder | OUntitled | OTab | ENone | Env | EGlobals | EEmpty | CEnv | CDomain | CCookie | CEmpty;

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

const SUMMARY_FRESH_MS = 30_000;
/** batas aman "Loading…" bila VS Code tidak pernah meminta data section (lihat Sidebar.showLoading) */
const LOADING_MAX_MS = 5000;
/** "Loading…" tampil minimal segini bila data sudah terkirim sebelum section terlihat (supaya tidak berkedip) */
const LOADING_MIN_MS = 250;

/** Environment di tree: ikon sama untuk semua baris; aktif = lingkaran terisi hijau (+ warna label lewat FileDecoration), tidak aktif = lingkaran kosong */
const envIcon = (active: boolean, idle: string): vscode.ThemeIcon =>
  active ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')) : new vscode.ThemeIcon(idle, new vscode.ThemeColor('descriptionForeground'));
/** uri semu per Environment (nama kosong = No Environment) supaya label aktif bisa diwarnai provider dekorasi */
const envUri = (name: string | undefined): vscode.Uri => vscode.Uri.from({ scheme: ENV_SCHEME, path: `/${name ?? ''}` });
const ENV_SCHEME = 'httpme-env';

export class Sidebar implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  private changed = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly dragMimeTypes = [TREE_MIME, 'text/uri-list'];
  readonly dropMimeTypes = [TREE_MIME, 'text/uri-list'];
  view!: vscode.TreeView<Node>;
  private scan: Promise<{ files: vscode.Uri[]; keep: vscode.Uri[] }> | undefined;
  private summaries = new Map<string, { mtime: number; at: number; s: RequestSummary }>();
  private filter = '';
  private onlyUnsaved = false;

  constructor(private state: vscode.Memento, private envs: Environments, private cookies: Cookies, readonly mode: SidebarMode = 'collections') {}

  /** bar progress di atas section selama isi / item sedang dimuat (tidak tampil kosong tanpa tanda) */
  private busy = busyTracker(() => {
    let done!: () => void;
    const gate = new Promise<void>((ok) => { done = ok; });
    void vscode.window.withProgress({ location: { viewId: VIEW_IDS[this.mode] } }, () => gate);
    return done;
  });

  private get flat(): boolean { return this.state.get<boolean>(this.mode === 'open' ? OPEN_FLAT_KEY : FLAT_KEY, false); }

  async toggleFlat(): Promise<void> {
    await this.state.update(this.mode === 'open' ? OPEN_FLAT_KEY : FLAT_KEY, !this.flat);
    await this.applyContext();
    this.changed.fire();
  }
  /** context key tombol toolbar section ini (ikon List / Tree, filter, Unsaved only) */
  async applyContext(): Promise<void> {
    if (this.mode === 'collections') {
      await vscode.commands.executeCommand('setContext', 'httpme.collectionsFlat', this.flat);
      await vscode.commands.executeCommand('setContext', 'httpme.collectionsFiltered', !!this.filter);
    }
    if (this.mode === 'open') {
      await vscode.commands.executeCommand('setContext', 'httpme.openFlat', this.flat);
      await vscode.commands.executeCommand('setContext', 'httpme.openOnlyUnsaved', this.onlyUnsaved);
    }
    if (this.view) this.updateDescription();
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
    if (this.mode !== 'open') {
      this.view.description = this.mode === 'collections' && this.filter ? `Filter: ${this.filter}` : undefined;
      return;
    }
    const tabs = this.openTabs();
    const unsaved = tabs.filter((t) => t.dirty).length;
    this.view.badge = unsaved ? { value: unsaved, tooltip: `${unsaved} unsaved request${unsaved === 1 ? '' : 's'}` } : undefined;
    this.view.description = this.onlyUnsaved ? `Unsaved (${unsaved})` : tabs.length ? String(tabs.length) : undefined;
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

  /** file berubah / dihapus: ringkasannya dibaca ulang saat dibutuhkan */
  invalidate(uri: vscode.Uri): void { this.summaries.delete(uri.toString()); }

  /** isi cache ringkasan di latar belakang (per 20 file) supaya section langsung penuh saat dibuka */
  async warm(): Promise<void> {
    const { files } = await this.list();
    for (let i = 0; i < files.length && i < 500; i += 20) {
      await Promise.all(files.slice(i, i + 20).map((u) => this.summary(u)));
      await new Promise((ok) => setTimeout(ok, 0)); // beri jalan ke pekerjaan lain
    }
  }

  /** method / host / judul file (dibaca saat ditampilkan, di-cache per mtime) */
  async summary(uri: vscode.Uri): Promise<RequestSummary> {
    const key = uri.toString();
    try {
      // cache segar (< 30 dtk, dibuang watcher saat file berubah): tanpa stat per file, supaya membuka section tidak menunggu puluhan I/O
      const cached = this.summaries.get(key);
      if (cached && Date.now() - cached.at < SUMMARY_FRESH_MS) return cached.s;
      const stat = await vscode.workspace.fs.stat(uri);
      const hit = this.summaries.get(key);
      if (hit && hit.mtime === stat.mtime) { hit.at = Date.now(); return hit.s; }
      const s = requestSummary(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
      this.summaries.set(key, { mtime: stat.mtime, at: Date.now(), s });
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

  /** urutan kustom dari `.httpme/order.json`; file rusak / tak terbaca = urutan default (error dilaporkan) */
  private async order(root: vscode.WorkspaceFolder): Promise<OrderMap> {
    if (root.uri.scheme !== 'file') return {};
    try {
      return await readOrder(root.uri.fsPath);
    } catch (e) {
      reportError('sidebar.order', e, `http.me: ${errMsg(e)}`);
      return {};
    }
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
    const saved = (await this.order(root))[folder?.rel ?? ''];
    const out: Node[] = [
      ...applyOrder(kids.folders, path.posix.basename, saved).map((r): Folder => ({ kind: 'folder', root, rel: r })),
      ...applyOrder(kids.files, path.posix.basename, saved).map((r): File => ({ kind: 'file', uri: vscode.Uri.joinPath(root.uri, r) })),
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
    return [{ kind: 'eglobals' }, { kind: 'enone' }, ...list]; // Globals di atas (berlaku untuk semua), lalu No Environment, lalu Environment
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

  // ---------- Cookies: Environment → domain → cookie ----------
  private async cookieChildren(n?: Node): Promise<Node[]> {
    if (!n) {
      const envs = await this.cookies.environments();
      const withCookies = [];
      for (const env of envs) if ((await this.cookies.jar(env)).length || env === this.cookies.env) withCookies.push(env);
      const total = (await Promise.all(withCookies.map((e) => this.cookies.jar(e)))).reduce((a, j) => a + j.length, 0);
      return [...withCookies.map((env): CEnv => ({ kind: 'cenv', env })), ...(total ? [] : [{ kind: 'cempty' } as CEmpty])];
    }
    if (n.kind === 'cenv') {
      const domains = [...new Set((await this.cookies.jar(n.env)).map((c) => c.domain))].sort((a, b) => a.localeCompare(b));
      return domains.map((domain): CDomain => ({ kind: 'cdomain', env: n.env, domain }));
    }
    if (n.kind === 'cdomain') return (await this.cookies.jar(n.env)).filter((c) => c.domain === n.domain).map((cookie): CCookie => ({ kind: 'cookie', env: n.env, cookie }));
    return [];
  }

  /** "Loading http.me…" tiap section hilang setelah DATA section itu sendiri siap (bukan saat section lain selesai), supaya tidak sempat kosong */
  private markLoaded(): void {
    if (this.loadedSet) return;
    this.loadedSet = true;
    void vscode.commands.executeCommand('setContext', `httpme.loaded.${this.mode}`, true);
  }
  private loadedSet = false;

  /** isi section (tanpa menandai "loaded"): dipakai getChildren dan pemanasan cache saat aktif */
  private fetch(n?: Node): Promise<Node[]> {
    if (this.mode === 'open') return Promise.resolve(this.openChildrenOf(n)); // dari tab terbuka, tanpa I/O
    if (this.mode === 'cookies') return this.busy(this.cookieChildren(n));
    if (this.mode === 'environments') return this.busy(this.environmentChildren(n));
    return this.busy(this.collectionChildren(n));
  }

  getChildren(n?: Node): Promise<Node[]> {
    return this.fetch(n).finally(() => { this.markLoaded(); if (!n) { this.rootDelivered = true; this.loadingDone?.(); } }); // "Loading…" hilang setelah DATA section ini siap
  }

  /** pemanasan cache saat aktif: section belum ditampilkan, jadi tidak boleh menandai "loaded" (kalau ditandai, pesan Loading hilang sebelum ada isi) */
  prefetch(): Promise<unknown> { return this.fetch(); }

  private loadingShown = false;
  private loadingDone?: () => void;
  private rootDelivered = false; // VS Code sudah menerima isi root (permintaan data datang sebelum event visibility)
  /**
   * Pertama kali section dibuka, VS Code menahan baris view extension ~2 dtk tanpa tanda apa pun (blank), sampai ada `message`.
   * Maka "Loading…" + bar progress dipasang segera saat section terlihat dan ditutup begitu data pertama dikirim ke VS Code.
   */
  showLoading(): void {
    if (this.loadingShown) return;
    this.loadingShown = true;
    this.view.message = 'Loading…';
    const done = new Promise<void>((ok) => { this.loadingDone = ok; });
    const safety = setTimeout(() => this.loadingDone?.(), LOADING_MAX_MS); // jangan pernah tertinggal
    if (this.rootDelivered) setTimeout(() => this.loadingDone?.(), LOADING_MIN_MS); // data sudah di tangan VS Code: cukup tampil sebentar
    void vscode.window.withProgress({ location: { viewId: VIEW_IDS[this.mode] } }, () => done);
    void done.then(() => { clearTimeout(safety); this.loadingDone = undefined; setTimeout(() => { this.view.message = undefined; }, 0); });
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

  getTreeItem(n: Node): Promise<vscode.TreeItem> {
    return this.busy(this.treeItem(n)); // file: ringkasan method / host dibaca dari disk
  }

  private async treeItem(n: Node): Promise<vscode.TreeItem> {
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
          command: { command: 'httpme.openRequest', title: 'Open', arguments: [n.uri, true] },
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
        return Object.assign(new vscode.TreeItem('No Environment'), {
          id: 'enone', resourceUri: envUri(undefined), iconPath: envIcon(on, 'circle-slash'), description: on ? 'active' : undefined,
          tooltip: on ? 'Active: requests are sent without an Environment' : 'Send requests without an Environment', contextValue: 'httpmeNoEnvironment',
          command: { command: 'httpme.setActiveEnvironment', title: 'Set Active', arguments: [undefined] },
        });
      }
      case 'env': {
        const on = this.envs.active === n.name;
        const nulls = await this.nullCount(n.name);
        return Object.assign(new vscode.TreeItem(n.name), {
          id: `env:${n.name}`, resourceUri: envUri(n.name), iconPath: envIcon(on, 'circle-large-outline'),
          description: [on ? 'active' : '', nulls ? `${nulls} NULL` : nulls === undefined ? 'invalid file' : ''].filter(Boolean).join(' · ') || undefined,
          tooltip: `${on ? 'Active Environment\n' : ''}${ENV_DIR}/${n.name}.json${nulls ? `\n${nulls} variable${nulls === 1 ? '' : 's'} without a value (NULL)` : ''}`,
          contextValue: on ? 'httpmeEnvironmentActive' : 'httpmeEnvironment',
          command: { command: 'httpme.openEnvironment', title: 'Open', arguments: [n.name, true] },
        });
      }
      case 'eglobals':
        return Object.assign(new vscode.TreeItem('Globals'), {
          id: 'eglobals', iconPath: new vscode.ThemeIcon('globe', new vscode.ThemeColor('charts.blue')), description: 'every Environment', tooltip: 'Variables for every Environment, stored on this computer',
          contextValue: 'httpmeGlobals', command: { command: 'httpme.openGlobals', title: 'Open Globals', arguments: [true] },
        });
      case 'cenv': {
        const n2 = (await this.cookies.jar(n.env)).length;
        const active = n.env === this.cookies.env;
        return Object.assign(new vscode.TreeItem(n.env || 'No Environment', n2 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None), {
          id: `cenv:${n.env}`, iconPath: new vscode.ThemeIcon(active ? 'check' : 'symbol-namespace'),
          description: [active ? 'active' : '', `${n2} cookie${n2 === 1 ? '' : 's'}`].filter(Boolean).join(' · '), contextValue: 'httpmeCookieEnv',
        });
      }
      case 'cdomain': {
        const n2 = (await this.cookies.jar(n.env)).filter((c) => c.domain === n.domain).length;
        return Object.assign(new vscode.TreeItem(n.domain, vscode.TreeItemCollapsibleState.Expanded), {
          id: `cdomain:${n.env}|${n.domain}`, iconPath: new vscode.ThemeIcon('globe'), description: String(n2), contextValue: 'httpmeCookieDomain',
        });
      }
      case 'cookie': {
        const c = n.cookie;
        const exp = c.expires === undefined ? 'session' : c.expires < Date.now() ? 'expired' : `expires ${new Date(c.expires).toISOString().slice(0, 16).replace('T', ' ')}`;
        return Object.assign(new vscode.TreeItem(c.name), {
          id: `cookie:${n.env}|${c.domain}|${c.path}|${c.name}`, iconPath: new vscode.ThemeIcon('key'),
          description: `${maskCookie(c.value)} · ${exp}`,
          tooltip: `${c.name} (value hidden)\nDomain: ${c.hostOnly ? '' : '.'}${c.domain}\nPath: ${c.path}\n${exp}${c.httpOnly ? '\nHttpOnly' : ''}${c.secure ? '\nSecure' : ''}`,
          contextValue: 'httpmeCookie',
        });
      }
      case 'cempty':
        return Object.assign(new vscode.TreeItem('No cookies'), { iconPath: new vscode.ThemeIcon('info'), description: 'cookies from responses are saved here', contextValue: 'httpmeEmpty' });
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

  /** true bila semua `uris` file .http se-folder dengan `before` (urutan diubah); false = bukan reorder, lanjut jadi pindah */
  private async reorderOnDrop(uris: vscode.Uri[], before: vscode.Uri): Promise<boolean> {
    const root = vscode.workspace.getWorkspaceFolder(before);
    const dir = path.posix.dirname(before.path);
    if (!root || root.uri.scheme !== 'file' || !uris.length || !uris.every((u) => /\.http$/i.test(u.path) && path.posix.dirname(u.path) === dir)) return false;
    // urut dari yang paling atas supaya beberapa file terpilih tetap berurutan di depan target
    for (const u of uris) await reorderChild(root.uri.fsPath, path.posix.relative(root.uri.path, u.path), { before: path.posix.basename(before.path) });
    return true;
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
    // file .http dilepas di atas file saudaranya (satu folder): urutan Collections diubah, bukan dipindah
    if (own && target?.kind === 'file' && await this.reorderOnDrop(uris, target.uri)) return this.redraw();
    // file spec / collection dari luar (Explorer, OS): diimpor, bukan dipindah
    const specs = own ? [] : importableFiles(list).map((u) => vscode.Uri.parse(u));
    if (specs.length) return void vscode.commands.executeCommand('httpme.import', 'file', specs); // tidak ditunggu: preview menunggu user
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

/** buka file dari Collections di panel http.me (file multi-request = tab per request + Send All) */
export async function openRequest(uri: vscode.Uri, keepFocus = false): Promise<void> {
  // dari klik sidebar: fokus tetap di tree supaya tombol Delete / F2 bekerja pada item terpilih
  await vscode.commands.executeCommand('vscode.openWith', uri, REQUEST_VIEW, keepFocus ? { preserveFocus: true } : undefined);
}

/**
 * 4 section sidebar + facade untuk extension.ts / itest: refresh / redraw semua section; `mode` = section terakhir
 * yang dibuka lewat command Show… (getChildren / getTreeItem diteruskan ke section itu)
 */
export class Sidebars {
  current: SidebarMode = 'collections';
  constructor(readonly sections: Record<SidebarMode, Sidebar>) {}
  get mode(): SidebarMode { return this.current; }
  private get s(): Sidebar { return this.sections[this.current]; }
  refresh(): void { this.sections.collections.refresh(); }
  redraw(): void { for (const x of Object.values(this.sections)) x.redraw(); }
  getChildren(n?: Node): Promise<Node[]> { return this.s.getChildren(n); }
  getTreeItem(n: Node): Promise<vscode.TreeItem> { return this.s.getTreeItem(n); }
  getParent(n: Node): Node | undefined { return this.s.getParent(n); }
  handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> { return this.s.handleDrop(target, data); }
  handleDrag(nodes: readonly Node[], data: vscode.DataTransfer): void { this.s.handleDrag(nodes, data); }
  openTabs() { return this.sections.open.openTabs(); }
}

const isHttpmeTab = (t: vscode.Tab): boolean => {
  const input = t.input;
  return (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) && isHttpmeFile(input.uri);
};

/** tab http.me yang belum disimpan: dialog Save All / Don't Save / Cancel sebelum ditutup. Kembalikan tab yang boleh ditutup
 *  (semua bila Don't Save / tidak ada yang kotor; kosong bila Cancel; tab yang gagal / batal disimpan tetap terbuka) */
async function confirmUnsaved(tabs: readonly vscode.Tab[]): Promise<vscode.Tab[]> {
  const dirty = tabs.filter((t) => t.isDirty && isHttpmeTab(t));
  if (!dirty.length) return [...tabs];
  const uriOfTab = (t: vscode.Tab) => (t.input as { uri: vscode.Uri }).uri;
  const names = dirty.map((t) => (uriOfTab(t).scheme === 'untitled' ? path.posix.basename(uriOfTab(t).path) : vscode.workspace.asRelativePath(uriOfTab(t), multiRoot())));
  const { message, detail } = unsavedPrompt(names);
  const pick = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Save', "Don't Save");
  if (!pick) return []; // Cancel
  if (pick === 'Save') {
    for (const t of dirty) {
      const u = uriOfTab(t);
      if (u.scheme === 'untitled') await vscode.commands.executeCommand('httpme.saveUntitled', u);
      else await (await vscode.workspace.openTextDocument(u)).save();
    }
    const still = new Set<string | undefined>(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.isDirty).map((t) => uriOfTab(t)?.toString()));
    return tabs.filter((t) => !still.has((t.input as { uri?: vscode.Uri } | undefined)?.uri?.toString()));
  }
  return [...tabs];
}

export function registerSidebar(ctx: vscode.ExtensionContext, envs: Environments, cookies: Cookies): { sidebar: Sidebars; disposable: vscode.Disposable } {
  const make = (mode: SidebarMode, dnd: boolean): Sidebar => {
    const s = new Sidebar(ctx.workspaceState, envs, cookies, mode);
    s.view = vscode.window.createTreeView(VIEW_IDS[mode], {
      treeDataProvider: s, ...(dnd ? { dragAndDropController: s } : {}), canSelectMany: mode === 'collections', showCollapseAll: mode !== 'environments',
    });
    void s.applyContext();
    s.view.onDidChangeVisibility((e) => { if (e.visible) s.showLoading(); });
    if (s.view.visible) s.showLoading();
    return s;
  };
  const sections = { collections: make('collections', true), environments: make('environments', false), open: make('open', true), cookies: make('cookies', false) };
  const all = new Sidebars(sections);
  // Collections = section utama: command file / folder / filter bekerja di sini
  const sidebar = sections.collections;
  const view = sidebar.view;
  const openSide = sections.open;

  const run = (name: string, fn: (...a: never[]) => unknown) => (...args: never[]) =>
    Promise.resolve().then(() => fn(...args)).catch((e) => reportError(name, e, `http.me: ${errMsg(e)}`));
  const cmd = (id: string, fn: (...a: never[]) => unknown) => vscode.commands.registerCommand(id, run(id, fn));

  // watcher: file .http / .httpmekeep dibuat / dihapus / di-rename dari luar (git pull, Explorer)
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rescan = () => { clearTimeout(timer); timer = setTimeout(() => sidebar.refresh(), 200); };
  const orderWatcher = vscode.workspace.createFileSystemWatcher(`**/${ORDER_FILE}`); // urutan diubah dari Dashboard / git pull
  for (const ev of [orderWatcher.onDidCreate, orderWatcher.onDidDelete, orderWatcher.onDidChange]) ev(() => sidebar.redraw());
  const watchers = [vscode.workspace.createFileSystemWatcher('**/*.http'), vscode.workspace.createFileSystemWatcher(`**/${KEEP_FILE}`), orderWatcher];
  for (const w of watchers.slice(0, 2)) { w.onDidCreate(rescan); w.onDidDelete((u) => { sidebar.invalidate(u); rescan(); }); w.onDidChange((u) => { sidebar.invalidate(u); sidebar.redraw(); }); }

  // Open: ikut tab / dirty / save tanpa polling
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const redrawOpen = () => { clearTimeout(openTimer); openTimer = setTimeout(() => openSide.redraw(), 100); };

  // Open and Reveal: file aktif disorot di Collections
  const revealActive = async () => {
    if (!view.visible) return;
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined;
    const uri = input?.uri;
    if (!uri || !/\.http$/i.test(uri.path) || uri.scheme !== 'file') return;
    const { files } = await sidebar.list();
    if (files.some((u) => u.toString() === uri.toString())) await view.reveal({ kind: 'file', uri }, { select: true, focus: false, expand: true });
  };

  // isi semua cache sekarang (scan file, ringkasan, Environment, cookie): membuka / melipat section tidak lagi menunggu I/O
  setTimeout(() => {
    for (const x of Object.values(sections)) void x.prefetch().catch((e) => log().error(errorLine(`Sidebar.warm ${x.mode}`, e)));
    void sidebar.warm().catch((e) => log().error(errorLine('Sidebar.warm summaries', e)));
  }, 0);

  // label Environment aktif berwarna hijau + tanda centang di kanan (provider dekorasi untuk uri semu httpme-env:)
  const decorations = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  const decorationProvider = vscode.window.registerFileDecorationProvider({
    onDidChangeFileDecorations: decorations.event,
    provideFileDecoration: (uri) => {
      if (uri.scheme !== ENV_SCHEME) return undefined;
      const name = decodeURIComponent(uri.path.slice(1));
      return (envs.active ?? '') === name ? new vscode.FileDecoration('✓', 'Active Environment', new vscode.ThemeColor('charts.green')) : undefined;
    },
  });

  const disposable = vscode.Disposable.from(
    decorations, decorationProvider,
    ...Object.values(sections).map((x) => x.view), ...watchers, new vscode.Disposable(() => { clearTimeout(timer); clearTimeout(openTimer); }),
    vscode.window.tabGroups.onDidChangeTabs(() => { redrawOpen(); void revealActive().catch((e) => log().error(errorLine('revealActive', e))); }),
    vscode.workspace.onDidChangeTextDocument((e) => { if (isHttpmeFile(e.document.uri)) redrawOpen(); }),
    vscode.workspace.onDidSaveTextDocument(redrawOpen),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sidebar.refresh()),
    envs.onDidChange(() => { sections.environments.redraw(); sections.cookies.redraw(); decorations.fire(undefined); }),
    cookies.onDidChange(() => sections.cookies.redraw()),

    // Show Collections / Environments / Open / Cookies: buka & fokus section itu
    ...(['collections', 'environments', 'open', 'cookies'] as const).flatMap((m) => {
      const name = m[0].toUpperCase() + m.slice(1);
      const show = async () => { all.current = m; await vscode.commands.executeCommand(`${VIEW_IDS[m]}.focus`); };
      return [cmd(`httpme.show${name}`, show), cmd(`httpme.show${name}Active`, show)];
    }),
    cmd('httpme.toggleFlat', () => sidebar.toggleFlat()),
    cmd('httpme.toggleFlatOff', () => sidebar.toggleFlat()),
    cmd('httpme.toggleOpenFlat', () => openSide.toggleFlat()),
    cmd('httpme.toggleOpenFlatOff', () => openSide.toggleFlat()),
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
        { label: '$(cloud-download) Import…', description: 'Postman, OpenAPI / Swagger, cURL, URL', id: 'httpme.import' },
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
    cmd('httpme.reimportFromSource', async (a?: Arg) => {
      const dir = await targetDir(a);
      if (dir) await reimport(dir, envs, () => sidebar.refresh());
    }),
    cmd('httpme.export', async (a?: Arg) => {
      const dir = await targetDir(a);
      if (dir) await exportCollection(dir, envs, vscode.Uri.joinPath(ctx.globalStorageUri, 'httpme-cache', 'history').fsPath);
    }),
    cmd('httpme.openRequest', (uri: vscode.Uri, keepFocus?: boolean) => openRequest(uri, keepFocus === true)),
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
    ...([['httpme.moveUp', -1], ['httpme.moveDown', 1]] as const).map(([id, shift]) => cmd(id, async (a?: Arg) => {
      const uri = uriOf(a ?? view.selection[0]);
      const root = uri && vscode.workspace.getWorkspaceFolder(uri);
      if (!uri || !root || root.uri.scheme !== 'file') return;
      if (await reorderChild(root.uri.fsPath, path.posix.relative(root.uri.path, uri.path), { shift })) sidebar.refresh();
    })),
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
      for (const u of uris) {
        const done = await deleteWithFallback(u, (t, useTrash) => vscode.workspace.fs.delete(t, { recursive: true, useTrash }), async () =>
          (await vscode.window.showWarningMessage(`Delete ${path.posix.basename(u.path)} permanently?`, { modal: true, detail: 'This location has no trash, so the deletion cannot be undone.' }, 'Delete Permanently')) === 'Delete Permanently');
        if (done === 'cancelled') break;
      }
      sidebar.refresh();
    }),
    // tombol Delete di view Environments / Cookies: item terpilih diteruskan ke command Delete masing-masing (yang menampilkan konfirmasi)
    cmd('httpme.deleteSelectedEnvironment', () => {
      const n = sections.environments.view.selection[0];
      return n?.kind === 'env' ? vscode.commands.executeCommand('httpme.deleteEnvironment', n) : undefined;
    }),
    cmd('httpme.deleteSelectedCookie', () => {
      const n = sections.cookies.view.selection[0] as { kind: string; env?: string; domain?: string; cookie?: unknown } | undefined;
      if (!n) return undefined;
      if (n.cookie) return vscode.commands.executeCommand('httpme.deleteCookie', n);
      if (n.domain) return vscode.commands.executeCommand('httpme.deleteCookieDomain', n);
      return n.env !== undefined ? vscode.commands.executeCommand('httpme.clearCookies', n) : undefined;
    }),
    cmd('httpme.revealInExplorer', (a?: Arg) => vscode.commands.executeCommand('revealInExplorer', uriOf(a ?? view.selection[0]))),
    // Copy as cURL (bash / cmd) dan PowerShell: tanpa cookie; varian "with Cookies" menyertakan header Cookie + cookie jar Environment aktif
    ...([
      ['httpme.copyAsCurl', 'httpme.copyAsCurlWithCookies', 'cURL command', toCurl],
      ['httpme.copyAsCurlCmd', 'httpme.copyAsCurlCmdWithCookies', 'cURL (cmd) command', toCurlCmd],
      ['httpme.copyAsPowerShell', 'httpme.copyAsPowerShellWithCookies', 'PowerShell command', toPowerShell],
    ] as const).flatMap(([plain, withJar, label, render]) => ([false, true] as const).map((withCookies) =>
      cmd(withCookies ? withJar : plain, async (a?: Arg) => {
        const uri = uriOf(a ?? view.selection[0]);
        if (!uri) return;
        const text = (await vscode.workspace.openTextDocument(uri)).getText();
        const blocks = splitBlocks(text);
        const reqs = blocks.length > 1 ? blocks.map((b) => parseRequest(b.text)) : [parseRequest(text)];
        const out: string[] = [];
        for (const r of reqs) {
          let jar: string | undefined;
          if (withCookies) {
            const url = resolveRequest(r, await envs.scopes(r.vars)).request.url;
            jar = (await cookies.forUrl(url)).map((c) => `${c.name}=${c.value}`).join('; ') || undefined;
          }
          out.push(render(r, { withCookies, jar }));
        }
        await vscode.env.clipboard.writeText(out.join('\n\n'));
        void vscode.window.showInformationMessage(`${blocks.length > 1 ? `${blocks.length} ${label}s` : label} copied${withCookies ? ' with cookies' : ''}.`);
      }))),
    cmd('httpme.moveTo', (uri: vscode.Uri, dest: vscode.Uri) => moveInto([uri], dest).then(() => sidebar.refresh())),

    // Open
    cmd('httpme.openShowUnsaved', () => openSide.setOnlyUnsaved(true)),
    cmd('httpme.openShowAll', () => openSide.setOnlyUnsaved(false)),
    cmd('httpme.focusTab', async (uri: string, viewType?: string) => {
      const u = vscode.Uri.parse(uri);
      if (viewType) await vscode.commands.executeCommand('vscode.openWith', u, viewType);
      else await vscode.window.showTextDocument(u, { preview: false });
    }),
    // klik item Open = buka seperti tab-nya; dua pilihan eksplisit lewat ikon hover / menu klik kanan
    cmd('httpme.openTabAsText', async (a?: Arg) => { const u = uriOf(a); if (u) await vscode.commands.executeCommand('httpme.openAsText', u); }),
    cmd('httpme.openTabInPanel', async (a?: Arg) => { const u = uriOf(a); if (u) await vscode.commands.executeCommand('httpme.openInPanel', u); }),
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
      const close = await confirmUnsaved(tabs);
      if (close.length) await vscode.window.tabGroups.close(close);
    }),
    cmd('httpme.pinTab', async (a?: Arg) => {
      const u = uriOf(a)?.toString();
      if (!u) return;
      const pinned = ctx.workspaceState.get<string[]>(OPEN_PINNED, []);
      await ctx.workspaceState.update(OPEN_PINNED, pinned.includes(u) ? pinned : [...pinned, u]);
      openSide.redraw();
    }),
    cmd('httpme.unpinTab', async (a?: Arg) => {
      const u = uriOf(a)?.toString();
      await ctx.workspaceState.update(OPEN_PINNED, ctx.workspaceState.get<string[]>(OPEN_PINNED, []).filter((x) => x !== u));
      openSide.redraw();
    }),
    cmd('httpme.revealInCollections', async (a?: Arg) => {
      const u = uriOf(a);
      all.current = 'collections';
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      if (u?.scheme === 'file') await view.reveal({ kind: 'file', uri: u }, { select: true, focus: true, expand: true });
    }),
    cmd('httpme.saveAll', () => vscode.commands.executeCommand('workbench.action.files.saveAll')),
    cmd('httpme.closeAll', async () => {
      const mine = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => isHttpmeTab(t));
      if ((await confirmUnsaved(mine)).length === mine.length) await vscode.commands.executeCommand('workbench.action.closeAllEditors'); // batal / simpan dibatalkan: tidak ada yang ditutup
    }),
    cmd('httpme.closeAllUnpinned', async () => {
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => ({ tab: t, uri: (t.input as { uri?: vscode.Uri } | undefined)?.uri?.toString() }));
      const targets = closeTargets(tabs, ctx.workspaceState.get<string[]>(OPEN_PINNED, []), false).map((x) => x.tab);
      const close = await confirmUnsaved(targets);
      if (close.length) await vscode.window.tabGroups.close(close);
    }),
  );
  return { sidebar: all, disposable };
}
