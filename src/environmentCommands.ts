// command Environment + status bar "◉ Environment: <nama>" (lem tipis VS Code); logika file di environments.ts
import * as vscode from 'vscode';
import { createEnvironment, ENV_DIR, fromPostmanEnvironment, statusText, stepEnvironment, withKey, type EnvVar } from './environments';
import { GLOBALS, type Environments } from './envState';
import { ENV_VIEW, focusVariable, openCompare, setValue, type FocusMode } from './environmentEditor';
import { environmentFileName } from './store';
import { errMsg } from './log';
import { reportError } from './output';

/** argumen command dari tree (node { kind: 'env', name }) atau nama langsung */
type EnvArg = string | { kind: string; name?: string } | undefined;
const envName = (a: EnvArg): string | undefined => (typeof a === 'string' ? a : a?.kind === 'env' ? a.name : undefined);

/** Quick Pick: No Environment, daftar (aktif ✓), New Environment…, Manage Environments… */
async function selectEnvironment(envs: Environments): Promise<void> {
  const names = await envs.names();
  const active = envs.active;
  type Item = vscode.QuickPickItem & { run: () => unknown };
  const items: Item[] = [
    { label: `${active === undefined ? '$(check) ' : '$(blank) '}No Environment`, run: () => envs.setActive(undefined) },
    ...names.map((n): Item => ({ label: `${n === active ? '$(check) ' : '$(blank) '}${n}`, description: /prod/i.test(n) ? 'production' : undefined, run: () => envs.setActive(n) })),
    { label: '', kind: vscode.QuickPickItemKind.Separator, run: () => undefined },
    { label: '$(add) New Environment…', run: () => vscode.commands.executeCommand('httpme.newEnvironment') },
    { label: '$(settings-gear) Manage Environments…', run: () => vscode.commands.executeCommand('httpme.manageEnvironments') },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Select Environment', placeHolder: `Active: ${active ?? 'none'}` });
  await pick?.run();
}

async function askEnvName(title: string, envs: Environments, value = '', input?: string): Promise<string | undefined> {
  const names = await envs.names();
  input ??= await vscode.window.showInputBox({
    title, value, placeHolder: 'dev, uat, prod…',
    validateInput: (v) => {
      const f = environmentFileName(v);
      if (typeof f !== 'string') return v ? f.error : undefined;
      const n = f.replace(/\.json$/i, '');
      return n !== value && names.includes(n) ? `Environment "${n}" already exists` : undefined;
    },
  });
  if (input === undefined) return undefined;
  const f = environmentFileName(input);
  if (typeof f !== 'string') throw new Error(f.error);
  return f.replace(/\.json$/i, '');
}

/** salin / pindah semua nilai lokal (Secret, current value) dari Environment `from` ke `to` */
async function copyLocal(envs: Environments, from: string, to: string, move: boolean): Promise<void> {
  for (const x of await envs.vars(to)) {
    if (!x.secret) continue;
    const s = await envs.secret(from, x.key);
    if (s !== undefined) await envs.setSecret(to, x.key, s);
    if (move) await envs.setSecret(from, x.key, undefined);
  }
  if (move) return envs.renameCurrent(from, to);
  for (const [k, v] of Object.entries(envs.current(from))) await envs.setCurrent(to, k, v);
}

export function registerEnvironmentCommands(envs: Environments, refreshTree: () => void): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('httpme.environment', vscode.StatusBarAlignment.Left, 49);
  item.name = 'http.me Environment';
  item.command = 'httpme.selectEnvironment';
  item.tooltip = 'Select Environment (Ctrl+Alt+E)';
  const update = () => {
    const s = statusText(envs.active);
    item.text = s.text;
    item.backgroundColor = s.warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    item.show();
  };
  update();

  const run = (name: string, fn: (...a: never[]) => unknown) => (...args: never[]) =>
    Promise.resolve().then(() => fn(...args)).catch((e) => reportError(name, e, `http.me: ${errMsg(e)}`));
  const cmd = (id: string, fn: (...a: never[]) => unknown) => vscode.commands.registerCommand(id, run(id, fn));
  const needDir = () => {
    const dir = envs.dir;
    if (!dir) throw new Error('Open a folder first: Environments are stored in .httpme/environments.');
    return dir;
  };
  const open = (name: string) => vscode.commands.executeCommand('vscode.openWith', envs.uriOf(name), ENV_VIEW);

  return vscode.Disposable.from(
    item, envs.onDidChange(update),
    cmd('httpme.selectEnvironment', () => selectEnvironment(envs)),
    cmd('httpme.nextEnvironment', async () => envs.setActive(stepEnvironment(await envs.names(), envs.active, 1))),
    cmd('httpme.previousEnvironment', async () => envs.setActive(stepEnvironment(await envs.names(), envs.active, -1))),
    cmd('httpme.editActiveEnvironment', async () => {
      const a = envs.active;
      if (a && (await envs.names()).includes(a)) return open(a);
      const pick = await vscode.window.showInformationMessage('No active Environment.', 'Select Environment');
      if (pick) await selectEnvironment(envs);
    }),
    cmd('httpme.manageEnvironments', async () => {
      await vscode.commands.executeCommand('httpme.showEnvironments');
      await vscode.commands.executeCommand('httpme.sidebar.focus');
    }),
    cmd('httpme.newEnvironment', async (input?: string) => {
      const dir = needDir();
      const name = await askEnvName('New Environment', envs, '', input);
      if (!name) return;
      await createEnvironment(dir, name);
      refreshTree();
      envs.fire();
      if (input === undefined) await open(name);
    }),
    cmd('httpme.setActiveEnvironment', (a?: EnvArg) => envs.setActive(envName(a))),
    cmd('httpme.openEnvironment', (a?: EnvArg) => { const n = envName(a); return n === undefined ? undefined : open(n); }),
    cmd('httpme.openGlobals', async () => {
      try {
        await vscode.workspace.fs.stat(envs.globalsUri);
      } catch {
        await envs.write(GLOBALS, []); // Globals belum pernah dibuat (bukan error): file kosong dibuat dulu
      }
      await open(GLOBALS);
    }),
    cmd('httpme.openEnvironmentAsText', (a?: EnvArg) => {
      const n = typeof a === 'object' && a?.kind === 'eglobals' ? GLOBALS : envName(a);
      return n === undefined ? undefined : vscode.commands.executeCommand('vscode.openWith', envs.uriOf(n), 'default');
    }),
    cmd('httpme.revealEnvironment', (a?: EnvArg) => {
      const n = envName(a);
      return n === undefined ? undefined : vscode.commands.executeCommand('revealInExplorer', envs.uriOf(n));
    }),
    cmd('httpme.renameEnvironment', async (a?: EnvArg, input?: string) => {
      const from = envName(a);
      if (!from) return;
      const to = await askEnvName(`Rename Environment "${from}"`, envs, from, input);
      if (!to || to === from) return;
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(envs.uriOf(from)!, envs.uriOf(to)!);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Environment "${from}" could not be renamed`);
      await copyLocal(envs, from, to, true);
      refreshTree();
      envs.fire();
    }),
    cmd('httpme.duplicateEnvironment', async (a?: EnvArg, input?: string) => {
      const from = envName(a);
      if (!from) return;
      const to = await askEnvName(`Duplicate Environment "${from}"`, envs, `${from} copy`, input);
      if (!to) return;
      await vscode.workspace.fs.copy(envs.uriOf(from)!, envs.uriOf(to)!);
      await copyLocal(envs, from, to, false);
      refreshTree();
      envs.fire();
    }),
    cmd('httpme.deleteEnvironment', async (a?: EnvArg, confirmed?: boolean) => {
      const name = envName(a);
      if (!name) return;
      if (!confirmed && (await vscode.window.showWarningMessage(`Delete Environment "${name}"?`, { modal: true, detail: `${ENV_DIR}/${name}.json is moved to the trash. Its secrets and current values on this computer are removed.` }, 'Delete')) !== 'Delete') return;
      const vars = await envs.vars(name).catch(() => [] as EnvVar[]); // file rusak tetap boleh dihapus
      await vscode.workspace.fs.delete(envs.uriOf(name)!, { useTrash: true });
      for (const x of vars) if (x.secret) await envs.setSecret(name, x.key, undefined);
      await envs.resetCurrent(name);
      if (envs.active === name) await envs.setActive(undefined);
      refreshTree();
      envs.fire();
    }),
    cmd('httpme.importEnvironment', async (file?: vscode.Uri) => {
      const dir = needDir();
      const uri = file ?? (await vscode.window.showOpenDialog({ title: 'Import Postman Environment', filters: { 'Postman Environment': ['json'] }, canSelectMany: false }))?.[0];
      if (!uri) return;
      const env = fromPostmanEnvironment(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
      const f = environmentFileName(env.name.replace(/[<>:"|?*\\/\u0000-\u001f]/g, '-'));
      const name = typeof f === 'string' ? f.replace(/\.json$/i, '') : 'imported';
      if ((await envs.names()).includes(name)) throw new Error(`Environment "${name}" already exists: rename it first`);
      await createEnvironment(dir, name, env.vars);
      for (const [k, v] of Object.entries(env.secrets)) await envs.setSecret(name, k, v);
      refreshTree();
      envs.fire();
      void vscode.window.showInformationMessage(`Imported Environment "${name}" (${env.vars.length} variables).`);
    }),
    cmd('httpme.compareEnvironments', () => openCompare()),
    cmd('httpme.syncEnvironments', async () => {
      const changed = await envs.sync();
      void vscode.window.showInformationMessage(changed.length ? `Synced keys in ${changed.join(', ')}.` : 'Every Environment already has the same keys.');
    }),
    // Ctrl+Click / hover / webview: buka editor Environment aktif (atau Globals) di variable itu
    cmd('httpme.gotoVariable', async (name: string, mode?: FocusMode) => {
      const ctx = await envs.context();
      const active = ctx.environments.find((e) => e.name === ctx.active);
      const inGlobals = ctx.globals.has(name) && (!active || active.values.get(name) === undefined || (active.values.get(name) === null && typeof ctx.globals.get(name) === 'string'));
      if (inGlobals) return focusVariable(envs.globalsUri, name, mode ?? (ctx.globals.get(name) === null ? 'fill' : 'show'));
      if (!active) {
        const pick = await vscode.window.showInformationMessage(`Select an Environment to open "${name}".`, 'Select Environment');
        if (pick) await selectEnvironment(envs);
        return;
      }
      const has = active.values.has(name);
      await focusVariable(envs.uriOf(active.name)!, name, mode ?? (!has ? 'add' : active.values.get(name) === null ? 'fill' : 'show'));
    }),
    cmd('httpme.showSecret', async (env: string, key: string) => {
      const v = await envs.secret(env, key);
      void vscode.window.showInformationMessage(v === undefined ? `${key} has no value (NULL).` : `${key}: ${v}`);
    }),
    // Quick Fix: Set value in active Environment… / Set in Globals… (env '' = Globals)
    cmd('httpme.setVariableValue', async (name: string, env: string, value?: string) => {
      const where = env === GLOBALS ? 'Globals' : `Environment "${env}"`;
      const secret = (await envs.vars(env)).find((x) => x.key === name)?.secret;
      value ??= await vscode.window.showInputBox({ title: `Set value of ${name} in ${where}`, password: !!secret, prompt: secret ? 'Stored in VS Code SecretStorage' : 'Initial value (saved in the file)' });
      if (value === undefined) return;
      if (env !== GLOBALS && !(await envs.vars(env)).some((x) => x.key === name)) await envs.updateOthers((v) => withKey(v, name));
      await setValue(env, name, value);
    }),
    cmd('httpme.addVariableToAll', async (name: string) => {
      needDir();
      const changed = await envs.updateOthers((v) => withKey(v, name));
      if (!(await envs.names()).length) throw new Error('Create an Environment first');
      void vscode.window.showInformationMessage(changed.length ? `Added ${name} (NULL) to ${changed.join(', ')}.` : `${name} is already in every Environment.`);
      if (envs.active) await focusVariable(envs.uriOf(envs.active)!, name, 'fill');
    }),
  );
}
