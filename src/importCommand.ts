// Import… (lem VS Code): sumber File / URL / Clipboard → deteksi format → Import preview → tulis async (withProgress, Cancel) → popup hasil.
// Logika murni ada di importCommon / postman / openapi / jetbrainsEnv / importer / importSync.
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { importAuth } from './importFetch';
import { detectFormat, parseDoc, type ImportPlan, type ImportFile } from './importCommon';
import { importPostman } from './postman';
import { importOpenApi } from './openapi';
import { fromJetBrainsEnv } from './jetbrainsEnv';
import { applyPlan, conflictsOf, importQueue, reportMarkdown, summarize, undoImport, type ApplyResult, type Conflict } from './importer';
import { parseSource, planResync, sourceFile, SOURCE_FILE, type Source, type SyncItem } from './importSync';
import { fromPostmanEnvironment, serializeEnvironment, parseEnvironment, createEnvironment, type EnvVar } from './environments';
import { substitute } from './vars';
import { webviewPage } from './webviewPage';
import { errMsg, errorLine } from './log';
import { log, reportError } from './output';
import type { Environments } from './envState';
import { GLOBALS } from './envState';
import { importCurlText } from './httpEditor';

const MAX_BYTES = 20 * 1024 * 1024; // spec lebih besar dari ini ditolak dengan pesan jelas

type Loaded = { label: string; text: string; /** path file asal (untuk $ref relatif & jetbrains private) */ file?: string; source: Source };
type EnvImport = { kind: 'env' | 'globals'; name: string; vars: EnvVar[]; secrets: Record<string, string> };

let last: ApplyResult | undefined;

/** folder tujuan default: root workspace / httpme.collectionsRoot */
function defaultDir(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root || root.uri.scheme !== 'file') return undefined;
  const sub = vscode.workspace.getConfiguration('httpme', root.uri).get<string>('collectionsRoot', '').trim().replace(/^\/+|\/+$/g, '');
  return sub ? join(root.uri.fsPath, sub) : root.uri.fsPath;
}

async function fetchText(raw: string, envs: Environments): Promise<string> {
  const scopes = await envs.scopes([]);
  const url = substitute(raw.trim(), scopes).text;
  if (/\{\{/.test(url)) throw new Error(`The URL still has unresolved variables: ${url}`);
  // auth: `_auth.http` di root workspace, nilai {{variable}} dari Environment aktif / Globals
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const authText = root ? await fs.readFile(join(root, '_auth.http'), 'utf8').catch(() => undefined) : undefined; // tanpa _auth.http: tanpa auth
  const values = new Map<string, string>();
  for (const sc of [...scopes].reverse()) for (const [k, v] of sc.values) if (typeof v === 'string') values.set(k, v);
  const a = importAuth(url, authText, values);
  const res = await fetch(a.url, { headers: { Accept: 'application/json, application/yaml, text/yaml, */*', ...Object.fromEntries(a.headers) } });
  if (!res.ok) throw new Error(`Could not fetch ${url}: HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (check the _auth.http in the workspace root)' : ''}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error('The file is larger than 20 MB');
  return res.text();
}

async function load(kind: 'file' | 'url' | 'clipboard', envs: Environments, dropped?: vscode.Uri[]): Promise<Loaded[]> {
  if (kind === 'file') {
    const uris = dropped ?? await vscode.window.showOpenDialog({ title: 'Import', canSelectMany: true, filters: { 'Postman / OpenAPI / JetBrains': ['json', 'yaml', 'yml'] } });
    const out: Loaded[] = [];
    for (const u of uris ?? []) {
      const st = await fs.stat(u.fsPath);
      if (st.size > MAX_BYTES) throw new Error(`${basename(u.fsPath)} is larger than 20 MB`);
      out.push({ label: basename(u.fsPath), text: await fs.readFile(u.fsPath, 'utf8'), file: u.fsPath, source: { type: 'file', location: u.fsPath, format: '' } });
    }
    return out;
  }
  if (kind === 'url') {
    const url = await vscode.window.showInputBox({ title: 'Import from URL', prompt: 'Postman collection or OpenAPI / Swagger spec (variables like {{baseUrl}} are allowed)', placeHolder: '{{baseUrl}}/v3/api-docs' });
    return url ? [{ label: url, text: await fetchText(url, envs), source: { type: 'url', location: url, format: '' } }] : [];
  }
  const text = await vscode.env.clipboard.readText();
  return text.trim() ? [{ label: 'Clipboard', text, source: { type: 'clipboard', location: '', format: '' } }] : [];
}

async function envList(envs: Environments) {
  return Promise.all((await envs.names()).map(async (name) => ({ name, values: await envs.values(name) })));
}

/** deteksi + bangun rencana; Environment / Globals dikumpulkan terpisah, cURL langsung diteruskan ke import cURL */
async function build(loaded: Loaded[], envs: Environments): Promise<{ plan?: ImportPlan; envImports: EnvImport[]; curl: boolean }> {
  const files: ImportFile[] = [];
  const names: string[] = [];
  const warnings: string[] = [];
  const environmentVars: NonNullable<ImportPlan['environmentVars']> = [];
  const envImports: EnvImport[] = [];
  let format: ImportPlan['format'] = 'postman';
  let curl = false;
  const known = await envList(envs);
  for (const l of loaded) {
    const d = detectFormat(l.text);
    if (d.format === 'curl') { await importCurlText(l.text); curl = true; continue; }
    if (d.format === 'postman-environment' || d.format === 'postman-globals') {
      const e = fromPostmanEnvironment(l.text);
      envImports.push({ kind: d.format === 'postman-globals' ? 'globals' : 'env', name: e.name, vars: e.vars, secrets: e.secrets });
    } else if (d.format === 'jetbrains-env') {
      const priv = l.file && basename(l.file) === 'http-client.env.json' ? await fs.readFile(join(dirname(l.file), 'http-client.private.env.json'), 'utf8').catch(() => undefined) : undefined; // tanpa file private: hanya nilai publik
      for (const e of fromJetBrainsEnv(l.text, priv)) envImports.push({ kind: 'env', ...e });
    } else {
      const plan = d.format === 'postman-collection' ? importPostman(d.data) : importOpenApi(d.data, {
        envs: known,
        loadFile: (rel) => {
          if (!l.file) throw new Error(`external $ref "${rel}" needs a spec imported from a file`);
          return parseDoc(readFileSync(join(dirname(l.file), rel), 'utf8'));
        },
      });
      format = plan.format;
      names.push(plan.name);
      warnings.push(...plan.warnings);
      files.push(...plan.files);
      environmentVars.push(...(plan.environmentVars ?? []));
      if (loaded.length === 1) l.source.format = plan.format;
      if (loaded.length === 1 && l.source.type !== 'clipboard') files.push({ path: `${plan.name}/${SOURCE_FILE}`, content: sourceFile({ ...l.source, format: d.format }), warnings: [] });
    }
  }
  if (!files.length) return { envImports, curl };
  // tidak ada Environment untuk menampung base URL: jadi variable collection (_variables.json) supaya request langsung bisa dikirim
  if (environmentVars.length && !known.length) {
    const root = names[0];
    const hit = files.find((f) => f.path === `${root}/_variables.json`);
    const vars: EnvVar[] = [...(hit ? parseEnvironment(hit.content) : []), ...environmentVars.map((v) => ({ key: v.key, value: v.value }))];
    if (hit) hit.content = serializeEnvironment(vars); else files.push({ path: `${root}/_variables.json`, content: serializeEnvironment(vars), warnings: [] });
    environmentVars.length = 0;
  }
  return { plan: { name: names.join(', '), format, files, warnings, ...(environmentVars.length ? { environmentVars } : {}) }, envImports, curl };
}

type Choice = { selected: Set<string>; conflicts: Map<string, Conflict>; dir: string };

/** tab Import preview; selesai dengan pilihan user atau undefined (Cancel / tab ditutup) */
function preview(plan: ImportPlan, initialDir: string): Promise<Choice | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel('httpme.importPreview', `Import preview: ${plan.name}`, vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.html = webviewPage('importPreview', { cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64') });
    let dir = initialDir;
    let settled = false;
    const finish = (c: Choice | undefined) => { if (settled) return; settled = true; resolve(c); panel.dispose(); };
    const state = async () => {
      const exist = new Set(await conflictsOf(plan, dir));
      return { items: plan.files.map((f) => ({ path: f.path, warnings: f.warnings, exists: exist.has(f.path) })), name: plan.name, dir };
    };
    panel.webview.onDidReceiveMessage(async (m: { type: string; selected?: string[]; conflicts?: Record<string, Conflict> }) => {
      try {
        if (m.type === 'ready') void panel.webview.postMessage({ type: 'state', ...(await state()) });
        else if (m.type === 'cancel') finish(undefined);
        else if (m.type === 'browse') {
          const pick = await vscode.window.showOpenDialog({ title: 'Destination folder', canSelectFiles: false, canSelectFolders: true, defaultUri: vscode.Uri.file(dir) });
          if (pick?.[0]) { dir = pick[0].fsPath; void panel.webview.postMessage({ type: 'dir', ...(await state()) }); }
        } else if (m.type === 'import') finish({ selected: new Set(m.selected ?? []), conflicts: new Map(Object.entries(m.conflicts ?? {})), dir });
      } catch (e) {
        reportError(`importPreview.${m.type}`, e, `http.me: ${errMsg(e)}`);
      }
    });
    panel.onDidDispose(() => finish(undefined));
  });
}

async function applyEnvImports(list: EnvImport[], envs: Environments): Promise<string[]> {
  const done: string[] = [];
  const dir = envs.dir;
  if (!dir && list.some((e) => e.kind === 'env')) throw new Error('Open a folder to import Environments');
  for (const e of list) {
    if (e.kind === 'globals') {
      const old = await envs.vars(GLOBALS).catch((err) => { log().error(errorLine('import.globals', err)); return [] as EnvVar[]; });
      const merged = [...old.filter((o) => !e.vars.some((v) => v.key === o.key)), ...e.vars];
      await envs.write(GLOBALS, merged);
      for (const [k, v] of Object.entries(e.secrets)) await envs.setSecret(GLOBALS, k, v);
      done.push('Globals');
      continue;
    }
    const name = e.name.replace(/[<>:"|?*\\/\u0000-\u001f]/g, '-');
    if ((await envs.names()).includes(name)) { log().warn(`import: Environment "${name}" already exists, skipped`); continue; }
    await createEnvironment(dir!, name, e.vars);
    for (const [k, v] of Object.entries(e.secrets)) await envs.setSecret(name, k, v);
    done.push(name);
  }
  envs.fire();
  return done;
}

/** base URL baru: Environment aktif terisi, lainnya NULL */
async function addEnvironmentVars(vars: NonNullable<ImportPlan['environmentVars']>, envs: Environments): Promise<void> {
  const active = envs.active;
  for (const name of await envs.names()) {
    const cur = await envs.vars(name);
    const add = vars.filter((v) => !cur.some((c) => c.key === v.key)).map((v): EnvVar => ({ key: v.key, value: name === active ? v.value : null }));
    if (add.length) await envs.write(name, [...cur, ...add]);
  }
}

/** itest: tulis rencana lewat jalur yang sama dengan tombol Import (antrean, progress) */
export const importApply = (plan: ImportPlan, dir: string, envs: Environments, refresh: () => void): Promise<ApplyResult> =>
  runApply(plan, { selected: new Set(plan.files.map((f) => f.path)), conflicts: new Map(), dir }, envs, refresh);

async function runApply(plan: ImportPlan, c: Choice, envs: Environments, refresh: () => void, only?: Set<string>): Promise<ApplyResult> {
  return importQueue('import', async () => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Importing ${plan.name}…`, cancellable: true }, async (progress, token) => {
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    const selected = only ?? c.selected;
    let prev = 0;
    const res = await vscode.window.withProgress({ location: { viewId: 'httpme.sidebar' } }, () => applyPlan(plan, {
      dir: c.dir, selected, conflicts: c.conflicts, signal: ac.signal,
      onProgress: (d, t, p) => { progress.report({ increment: ((d - prev) / t) * 100, message: `${d} / ${t} · ${p}` }); prev = d; },
    }));
    if (plan.environmentVars?.length) await addEnvironmentVars(plan.environmentVars, envs);
    refresh(); // satu refresh di akhir (watcher *.http sudah di-debounce)
    return res;
  }));
}

async function showResult(plan: ImportPlan, c: Choice, res: ApplyResult, envs: Environments, refresh: () => void): Promise<void> {
  last = res;
  const s = summarize(res, plan.name);
  log().info(reportMarkdown(plan, res));
  for (const f of res.failed) log().error(`import: ${f.path} — ${f.error}`);
  const show = s.kind === 'success' ? vscode.window.showInformationMessage : s.kind === 'failed' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
  const pick = await show(`${s.message}${s.detail ? ` · ${s.detail.split('\n')[0]}` : ''}`, ...s.actions);
  if (pick === 'Show in Collections') await vscode.commands.executeCommand('httpme.sidebar.focus');
  else if (pick === 'Show report' || pick === 'Show log') log().show(true);
  else if (pick === 'Retry failed') {
    const again = await runApply(plan, c, envs, refresh, new Set(res.failed.map((f) => f.path)));
    await showResult(plan, c, { ...again, created: [...res.created, ...again.created] }, envs, refresh);
  } else if (pick === 'Remove created files') await undo();
}

async function undo(): Promise<void> {
  if (!last) return void vscode.window.showInformationMessage('There is no import to undo in this session.');
  const u = await undoImport(last);
  last = undefined;
  void vscode.window.showInformationMessage(`Removed ${u.removed} file${u.removed === 1 ? '' : 's'}${u.restored ? `, restored ${u.restored}` : ''}.${u.kept.length ? ` ${u.kept.length} changed file${u.kept.length === 1 ? ' was' : 's were'} kept.` : ''}`);
}

async function startImport(envs: Environments, refresh: () => void, kindArg?: 'file' | 'url' | 'clipboard', dropped?: vscode.Uri[]): Promise<void> {
  const dir = defaultDir();
  if (!dir) throw new Error('Open a folder first: imported requests are written into the workspace.');
  const kind = kindArg ?? (await vscode.window.showQuickPick([
    { label: '$(file) File…', description: 'Postman collection / environment, OpenAPI / Swagger, http-client.env.json', id: 'file' as const },
    { label: '$(globe) URL…', description: 'e.g. {{baseUrl}}/v3/api-docs', id: 'url' as const },
    { label: '$(clippy) Clipboard', description: 'cURL, Postman JSON or an OpenAPI spec', id: 'clipboard' as const },
  ], { placeHolder: 'Import from' }))?.id;
  if (!kind) return;
  let built: Awaited<ReturnType<typeof build>>;
  try {
    const loaded = await load(kind, envs, dropped);
    if (!loaded.length) return;
    built = await build(loaded, envs);
  } catch (e) {
    return reportError('import.read', e, `Import failed: ${errMsg(e)}`);
  }
  if (built.curl && !built.plan && !built.envImports.length) return;
  if (built.envImports.length) {
    const names = await applyEnvImports(built.envImports, envs);
    if (names.length) void vscode.window.showInformationMessage(`Imported ${names.length === 1 ? `Environment "${names[0]}"` : `${names.length} Environments`}.`);
  }
  if (!built.plan) return;
  const choice = await preview(built.plan, dir);
  if (!choice) return;
  try {
    await showResult(built.plan, choice, await runApply(built.plan, choice, envs, refresh), envs, refresh);
  } catch (e) {
    reportError('import.apply', e, `Import failed: ${errMsg(e)}`);
  }
}

/** semua .http di folder collection (relatif ke parent folder, dengan nama folder di depan) */
async function scan(folder: string, parent: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  for (const e of await fs.readdir(folder, { withFileTypes: true })) {
    const p = join(folder, e.name);
    if (e.isDirectory()) out.push(...await scan(p, parent));
    else if (/\.http$/i.test(e.name)) out.push({ path: relative(parent, p).replace(/\\/g, '/'), content: await fs.readFile(p, 'utf8') });
  }
  return out;
}


const RESYNC_SCHEME = 'httpme-resync';
/** isi dokumen virtual untuk vscode.diff (versi milik user vs hasil Update) */
const resyncDocs = new Map<string, string>();
let resyncProvider: vscode.Disposable | undefined;

/** daftar centang Update / Keep mine: centang = tulis hasil merge, tidak dicentang = pertahankan; tombol diff membuka perbandingan */
function pickResync(items: SyncItem[], root: string): Promise<SyncItem[]> {
  resyncProvider ??= vscode.workspace.registerTextDocumentContentProvider(RESYNC_SCHEME, { provideTextDocumentContent: (u) => resyncDocs.get(u.toString()) ?? '' });
  const label = { new: 'New', update: 'Update', removed: 'Removed in spec', unchanged: 'Unchanged' } as const;
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { item: SyncItem }>();
    qp.title = `Re-import from Source: ${root}`;
    qp.placeholder = 'Checked = Update (apply spec, keep your scripts and extra headers); unchecked = Keep mine';
    qp.canSelectMany = true;
    const diff = { iconPath: new vscode.ThemeIcon('diff'), tooltip: 'Show diff' };
    qp.items = items.map((item) => ({ label: `${label[item.kind]}: ${item.path}`, description: item.operation, item, buttons: item.kind === 'new' ? [] : [diff] }));
    qp.selectedItems = qp.items.filter((x) => x.item.kind !== 'removed');
    qp.onDidTriggerItemButton(async (e) => {
      const i = e.item.item;
      const mk = (side: string, text: string) => { const u = vscode.Uri.from({ scheme: RESYNC_SCHEME, path: `/${side}/${i.path}` }); resyncDocs.set(u.toString(), text); return u; };
      await vscode.commands.executeCommand('vscode.diff', mk('mine', i.existing ?? ''), mk('after-update', i.merged ?? ''), `${i.path} (mine ↔ after Update)`, { preview: true });
    });
    let done = false;
    const finish = (r: SyncItem[]) => { if (done) return; done = true; resyncDocs.clear(); qp.dispose(); resolve(r); };
    qp.onDidAccept(() => finish(qp.selectedItems.map((x) => x.item)));
    qp.onDidHide(() => finish([]));
    qp.show();
  });
}

export async function reimport(folder: vscode.Uri, envs: Environments, refresh: () => void): Promise<void> {
  const src = parseSource(await fs.readFile(join(folder.fsPath, SOURCE_FILE), 'utf8').catch(() => { throw new Error(`${basename(folder.fsPath)} has no ${SOURCE_FILE}: it was not imported from a file or URL`); }));
  if (src.type === 'clipboard') throw new Error('Clipboard sources cannot be re-imported');
  const text = src.type === 'url' ? await fetchText(src.location, envs) : await fs.readFile(src.location, 'utf8');
  const built = await build([{ label: src.location, text, ...(src.type === 'file' ? { file: src.location } : {}), source: src }], envs);
  if (!built.plan) throw new Error('The source no longer contains a collection');
  const root = basename(folder.fsPath);
  const prefix = `${built.plan.name}/`;
  const plan: ImportPlan = { ...built.plan, files: built.plan.files.filter((f) => f.path !== `${built.plan!.name}/${SOURCE_FILE}`).map((f) => ({ ...f, path: f.path.startsWith(prefix) ? `${root}/${f.path.slice(prefix.length)}` : f.path })) };
  const parent = dirname(folder.fsPath);
  const items = planResync(await scan(folder.fsPath, parent), plan).filter((i) => i.kind !== 'unchanged');
  if (!items.length) return void vscode.window.showInformationMessage('Already up to date with the source.');
  const picks = await pickResync(items, root);
  if (!picks.length) return;
  for (const p of picks) {
    const abs = join(parent, p.path);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, p.merged!);
  }
  refresh();
  void vscode.window.showInformationMessage(`Re-imported ${picks.length} item${picks.length === 1 ? '' : 's'} (the rest kept as yours) from ${basename(src.location)}.`);
}

export function registerImport(envs: Environments, refresh: () => void): vscode.Disposable[] {
  const run = (where: string, fn: () => Promise<void>) => fn().catch((e) => reportError(where, e, `http.me: ${errMsg(e)}`));
  return [
    vscode.commands.registerCommand('httpme.import', (kind?: 'file' | 'url' | 'clipboard', files?: vscode.Uri[]) =>
      run('import', () => startImport(envs, refresh, typeof kind === 'string' ? kind : undefined, Array.isArray(files) ? files : undefined))),
    vscode.commands.registerCommand('httpme.undoLastImport', () => run('undoLastImport', undo)),
  ];
}

