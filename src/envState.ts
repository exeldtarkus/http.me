// Environment di extension host (lem tipis VS Code): Environment aktif & current value (workspace state), Secret (SecretStorage),
// Globals (file di global storage), watcher .httpme/environments + deteksi key tidak sama. Logika file di environments.ts.
import * as vscode from 'vscode';
import { join } from 'node:path';
import {
  ENV_DIR, environmentValues, keyMismatch, listEnvironments, mismatchMessage, parseEnvironment, readEnvironment, serializeEnvironment, syncKeys,
  writeEnvironment, type EnvVar,
} from './environments';
import { fileScope, type Scope } from './vars';
import type { VarContext } from './diagnostics';
import type { ParsedRequest } from './httpFile';
import { errMsg, errorLine } from './log';
import { log, reportError } from './output';

const ACTIVE_KEY = 'environment.active';
const CURRENT_KEY = 'environment.current';
export const GLOBALS_FILE = 'httpme-globals.json';
export const GLOBALS = ''; // nama "Environment" untuk Globals di SecretStorage / pesan

export class Environments {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private lastMismatch = '';

  constructor(private ctx: vscode.ExtensionContext) {}

  /** shortcut: Environment hanya dari workspace folder pertama; dukung per folder bila ada permintaan multi-root */
  get dir(): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0];
    return root?.uri.scheme === 'file' ? join(root.uri.fsPath, ENV_DIR) : undefined;
  }
  get globalsUri(): vscode.Uri { return vscode.Uri.joinPath(this.ctx.globalStorageUri, GLOBALS_FILE); }
  uriOf(name: string): vscode.Uri | undefined {
    if (name === GLOBALS) return this.globalsUri;
    return this.dir ? vscode.Uri.file(join(this.dir, `${name}.json`)) : undefined;
  }
  /** nama Environment dari uri file (Globals = '') atau undefined bila bukan file Environment */
  nameOf(uri: vscode.Uri): string | undefined {
    if (uri.toString() === this.globalsUri.toString()) return GLOBALS;
    const dir = this.dir;
    if (!dir || uri.scheme !== 'file') return undefined;
    const m = /^(.*)[\\/]([^\\/]+)\.json$/i.exec(uri.fsPath);
    return m && vscode.Uri.file(m[1]).fsPath === vscode.Uri.file(dir).fsPath ? m[2] : undefined;
  }

  fire(): void { this.changed.fire(); }

  async names(): Promise<string[]> {
    const dir = this.dir;
    return dir ? listEnvironments(dir) : [];
  }

  /** isi Environment: dokumen terbuka (belum disimpan) lebih dulu, selain itu file (ttlCache) */
  async vars(name: string): Promise<EnvVar[]> {
    const uri = this.uriOf(name);
    if (!uri) return [];
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) return parseEnvironment(doc.getText(), `${name || 'Globals'}.json`);
    if (name === GLOBALS) {
      try {
        return parseEnvironment(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), 'Globals');
      } catch (e) {
        if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') return [];
        throw e;
      }
    }
    return readEnvironment(this.dir!, name);
  }

  /** tulis isi Environment: dokumen terbuka diedit lewat WorkspaceEdit (bisa Undo; yang belum dirty langsung disimpan), selain itu ke file */
  async write(name: string, vars: readonly EnvVar[]): Promise<void> {
    const uri = this.uriOf(name)!;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) {
      const wasDirty = doc.isDirty;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), serializeEnvironment(vars));
      await vscode.workspace.applyEdit(edit);
      if (!wasDirty) await doc.save();
    } else if (name === GLOBALS) {
      await vscode.workspace.fs.createDirectory(this.ctx.globalStorageUri);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeEnvironment(vars)));
    } else await writeEnvironment(this.dir!, name, vars);
    this.fire();
  }

  /** terapkan fn ke semua Environment kecuali `except`; kembalikan nama yang berubah */
  async updateOthers(fn: (vars: EnvVar[]) => EnvVar[], except?: string): Promise<string[]> {
    const changed: string[] = [];
    for (const name of await this.names()) {
      if (name === except) continue;
      const before = await this.vars(name);
      const after = fn(before);
      if (serializeEnvironment(after) === serializeEnvironment(before)) continue;
      await this.write(name, after);
      changed.push(name);
    }
    return changed;
  }

  get active(): string | undefined { return this.ctx.workspaceState.get<string>(ACTIVE_KEY); }
  async setActive(name: string | undefined): Promise<void> {
    await this.ctx.workspaceState.update(ACTIVE_KEY, name);
    vscode.window.setStatusBarMessage(`Environment: ${name ?? 'none'}`, 2500);
    this.fire();
  }

  current(name: string): Record<string, string> {
    return this.ctx.workspaceState.get<Record<string, Record<string, string>>>(CURRENT_KEY, {})[name] ?? {};
  }
  /** current value lokal (tidak di-commit); undefined = kembali ke initial value */
  async setCurrent(name: string, key: string, value: string | undefined): Promise<void> {
    const all = { ...this.ctx.workspaceState.get<Record<string, Record<string, string>>>(CURRENT_KEY, {}) };
    const cur = { ...(all[name] ?? {}) };
    if (value === undefined) delete cur[key]; else cur[key] = value;
    all[name] = cur;
    await this.ctx.workspaceState.update(CURRENT_KEY, all);
    this.fire();
  }
  async resetCurrent(name: string): Promise<void> {
    const all = { ...this.ctx.workspaceState.get<Record<string, Record<string, string>>>(CURRENT_KEY, {}) };
    delete all[name];
    await this.ctx.workspaceState.update(CURRENT_KEY, all);
    this.fire();
  }
  async renameCurrent(from: string, to: string): Promise<void> {
    const all = { ...this.ctx.workspaceState.get<Record<string, Record<string, string>>>(CURRENT_KEY, {}) };
    if (all[from]) { all[to] = all[from]; delete all[from]; }
    await this.ctx.workspaceState.update(CURRENT_KEY, all);
    if (this.active === from) await this.ctx.workspaceState.update(ACTIVE_KEY, to);
  }

  private secretKey(env: string, key: string): string {
    const scope = env === GLOBALS ? 'globals' : vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '';
    return `httpme.secret:${scope}:${env}:${key}`;
  }
  secret(env: string, key: string): Thenable<string | undefined> { return this.ctx.secrets.get(this.secretKey(env, key)); }
  async setSecret(env: string, key: string, value: string | undefined): Promise<void> {
    if (value === undefined) await this.ctx.secrets.delete(this.secretKey(env, key));
    else await this.ctx.secrets.store(this.secretKey(env, key), value);
    this.fire();
  }
  private async secretsOf(env: string, vars: readonly EnvVar[]): Promise<Record<string, string | undefined>> {
    const out: Record<string, string | undefined> = {};
    for (const x of vars) if (x.secret) out[x.key] = await this.secret(env, x.key);
    return out;
  }
  /** nilai efektif (current ?? initial, secret dari SecretStorage) */
  async values(env: string): Promise<Map<string, string | null>> {
    const vars = await this.vars(env);
    return environmentValues(vars, env === GLOBALS ? {} : this.current(env), await this.secretsOf(env, vars));
  }

  /** konteks diagnostics / hover / panel: nilai semua Environment + Globals */
  async context(): Promise<VarContext> {
    const environments = await Promise.all((await this.names()).map(async (name) => {
      try {
        const vars = await this.vars(name);
        return { name, values: environmentValues(vars, this.current(name), await this.secretsOf(name, vars)), secret: new Set(vars.filter((x) => x.secret).map((x) => x.key)) };
      } catch (e) {
        log().error(errorLine(`Environments.context ${name}`, e)); // file rusak: dilewati, pesan JSON tampil saat dibuka
        return { name, values: new Map(), secret: new Set<string>() };
      }
    }));
    const gvars = await this.vars(GLOBALS).catch((e) => { log().error(errorLine('Environments.context Globals', e)); return [] as EnvVar[]; });
    return {
      active: environments.some((e) => e.name === this.active) ? this.active : undefined, environments,
      globals: environmentValues(gvars, {}, await this.secretsOf(GLOBALS, gvars)), globalSecret: new Set(gvars.filter((x) => x.secret).map((x) => x.key)),
    };
  }

  /** scope untuk Send: variabel file → Environment aktif → Globals (script & collection menyusul di fase berikutnya) */
  async scopes(fileVars: ParsedRequest['vars']): Promise<Scope[]> {
    const out: Scope[] = [fileScope(fileVars)];
    const active = this.active;
    if (active && (await this.names()).includes(active)) out.push({ source: 'environment', name: active, values: await this.values(active) });
    out.push({ source: 'globals', values: await this.values(GLOBALS) });
    return out;
  }

  /** semua nilai Secret (Environment aktif + Globals) untuk di-mask di log */
  async secretValues(): Promise<string[]> {
    const out: string[] = [];
    for (const env of [this.active, GLOBALS]) {
      if (env === undefined) continue;
      const vars = await this.vars(env).catch(() => [] as EnvVar[]); // file rusak: tidak ada secret yang bisa dibaca (dicatat saat context())
      for (const v of Object.values(await this.secretsOf(env, vars))) if (v) out.push(v);
    }
    return out;
  }

  /** key tidak sama (edit manual / git pull): notifikasi + Sync, tanpa menulis diam-diam; kembalikan pesan ('' = sama) */
  async checkKeys(): Promise<string> {
    const envs = await Promise.all((await this.names()).map(async (name) => ({ name, vars: await this.vars(name).catch(() => undefined) })));
    const ok = envs.filter((e): e is { name: string; vars: EnvVar[] } => !!e.vars); // file rusak dilewati
    const miss = keyMismatch(ok);
    const msg = mismatchMessage(miss);
    if (msg === this.lastMismatch) return msg;
    this.lastMismatch = msg;
    if (!msg) return msg;
    void vscode.window.showWarningMessage(`${msg}.`, 'Sync').then(async (pick) => {
      if (pick !== 'Sync') return;
      try {
        await this.sync();
      } catch (e) {
        reportError('Environments.sync', e, `Sync failed: ${errMsg(e)}`);
      }
    });
    return msg;
  }

  /** Sync: key yang hilang ditambahkan dengan NULL ke tiap Environment */
  async sync(): Promise<string[]> {
    const envs = await Promise.all((await this.names()).map(async (name) => ({ name, vars: await this.vars(name) })));
    const changed: string[] = [];
    for (const e of envs) {
      const after = syncKeys(e.vars, envs);
      if (after.length === e.vars.length) continue;
      await this.write(e.name, after);
      changed.push(e.name);
    }
    this.lastMismatch = '';
    return changed;
  }

  /** watcher file Environment: cache dibaca ulang, cek key, tampilan diperbarui */
  watch(): vscode.Disposable {
    const w = vscode.workspace.createFileSystemWatcher(`**/${ENV_DIR}/*.json`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFile = (uri: vscode.Uri) => {
      const name = this.nameOf(uri);
      if (name === undefined) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void readEnvironment(this.dir!, name, true).catch(() => undefined) // file dihapus / rusak: dicatat saat dipakai
          .then(() => { this.fire(); return this.checkKeys(); })
          .catch((e) => log().error(errorLine('Environments.watch', e)));
      }, 300);
    };
    let docTimer: ReturnType<typeof setTimeout> | undefined;
    return vscode.Disposable.from(
      w, w.onDidCreate(onFile), w.onDidChange(onFile), w.onDidDelete(onFile), this.changed,
      // ketik di file Environment (editor teks / tabel): diagnostics & warna ikut, tanpa menunggu Save
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.nameOf(e.document.uri) === undefined || !e.contentChanges.length) return;
        clearTimeout(docTimer);
        docTimer = setTimeout(() => this.fire(), 300);
      }),
      new vscode.Disposable(() => { clearTimeout(timer); clearTimeout(docTimer); }),
      // Save (tombol editor atau Ctrl+S): key disinkronkan ke semua Environment; Globals tidak ikut
      vscode.workspace.onDidSaveTextDocument((d) => {
        const name = this.nameOf(d.uri);
        if (name === undefined || name === GLOBALS) return;
        // editor teks tidak punya tombol / pesan: beri tahu hasil sync, dan kegagalan (JSON Environment lain rusak) tampil, bukan hanya di log
        this.sync().then((changed) => { if (changed.length) void vscode.window.showInformationMessage(`Synced keys in ${changed.join(', ')}.`); })
          .catch((e) => reportError('Environments.save', e, `Sync after save failed: ${errMsg(e)}`));
      }),
    );
  }
}
