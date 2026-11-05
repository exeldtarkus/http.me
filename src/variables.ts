// {{variable}} di editor VS Code (lem tipis): Diagnostics "http.me", Quick Fix, Hover, Definition / Peek, References, autocomplete {{.
// Inti (token, status, pesan, hover) di diagnostics.ts; hanya dokumen yang terbuka yang dicek (hemat RAM).
import * as vscode from 'vscode';
import {
  completionNames, diagnoseEnvironmentJson, diagnoseHttp, fileVariables, findKeyInJson, findReferences, findVarTokens, hoverInfo, hoverMarkdown,
  type VarContext, type VarToken,
} from './diagnostics';
import { GLOBALS, type Environments } from './envState';
import { focusVariable } from './environmentEditor';
import { HTTP_FILES } from './codelens';
import { errorLine } from './log';
import { log } from './output';

const isHttp = (d: vscode.TextDocument) => d.languageId === 'http' || /\.http$/i.test(d.uri.path);
const isScript = (d: vscode.TextDocument) => /(^|\/)(pre|post)-request\.js$/i.test(d.uri.path);
const SCRIPTS: vscode.DocumentSelector = [{ pattern: '**/{pre,post}-request.js' }];

/** token di posisi kursor */
function tokenAt(doc: vscode.TextDocument, pos: vscode.Position): VarToken | undefined {
  const off = doc.offsetAt(pos);
  return findVarTokens(doc.getText(), isScript(doc)).find((t) => off >= t.start && off <= t.end);
}
const rangeOf = (doc: vscode.TextDocument, t: { start: number; end: number }) => new vscode.Range(doc.positionAt(t.start), doc.positionAt(t.end));

export function registerVariables(envs: Environments): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('http.me');
  let ctx: Promise<VarContext> | undefined;
  /** konteks dibangun ulang hanya saat Environment / Globals berubah */
  const context = () => (ctx ??= envs.context().catch((e) => {
    log().error(errorLine('variables.context', e));
    ctx = undefined;
    return { environments: [], globals: new Map() } as VarContext;
  }));

  const check = async (doc: vscode.TextDocument) => {
    const name = envs.nameOf(doc.uri);
    if (name !== undefined) {
      if (name === GLOBALS) return;
      return collection.set(doc.uri, diagnoseEnvironmentJson(doc.getText(), name).map((d) => {
        // "value": null di file Environment = belum diisi (keadaan normal), bukan kesalahan: biru, bukan merah
        const x = new vscode.Diagnostic(rangeOf(doc, d), d.message, vscode.DiagnosticSeverity.Information);
        x.source = 'http.me';
        x.code = 'null-in-file';
        return x;
      }));
    }
    if (!isHttp(doc) && !isScript(doc)) return;
    const c = await context();
    collection.set(doc.uri, diagnoseHttp(doc.getText(), c, isScript(doc)).map((d) => {
      const x = new vscode.Diagnostic(rangeOf(doc, d), d.message, vscode.DiagnosticSeverity.Error);
      x.source = 'http.me';
      x.code = d.kind; // null | missing: dipakai Quick Fix
      return x;
    }));
  };
  const checkAll = () => vscode.workspace.textDocuments.forEach((d) => void check(d).catch((e) => log().error(errorLine('variables.check', e))));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const later = (doc: vscode.TextDocument) => {
    const k = doc.uri.toString();
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => { timers.delete(k); void check(doc).catch((e) => log().error(errorLine('variables.check', e))); }, 300));
  };
  checkAll();

  const selector = [...(HTTP_FILES as vscode.DocumentFilter[]), ...(SCRIPTS as vscode.DocumentFilter[])];

  const quickFix: vscode.CodeActionProvider = {
    async provideCodeActions(doc, _range, cx) {
      const c = await context();
      const out: vscode.CodeAction[] = [];
      for (const d of cx.diagnostics.filter((x) => x.source === 'http.me' && (x.code === 'null' || x.code === 'missing'))) {
        const t = tokenAt(doc, d.range.start);
        if (!t || t.name.startsWith('$')) continue;
        const fix = (title: string, command: string, args: unknown[]) => {
          const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
          a.diagnostics = [d];
          a.command = { title, command, arguments: args };
          out.push(a);
        };
        if (c.active) fix(`Set value of ${t.name} in Environment "${c.active}"…`, 'httpme.setVariableValue', [t.name, c.active]);
        fix(`Set ${t.name} in Globals…`, 'httpme.setVariableValue', [t.name, GLOBALS]);
        if (d.code === 'missing' && c.environments.length) fix(`Add variable "${t.name}" to every Environment`, 'httpme.addVariableToAll', [t.name]);
        fix('Open All Environments', 'httpme.compareEnvironments', []);
      }
      return out;
    },
  };

  const hover: vscode.HoverProvider = {
    async provideHover(doc, pos) {
      const t = tokenAt(doc, pos);
      if (!t) return undefined;
      const md = new vscode.MarkdownString(hoverMarkdown(hoverInfo(t.name, await context(), isHttp(doc) ? fileVariables(doc.getText()) : new Map())), true);
      md.isTrusted = { enabledCommands: ['httpme.showSecret', 'httpme.gotoVariable'] };
      return new vscode.Hover(md, rangeOf(doc, t));
    },
  };

  /** F12 / Ctrl+Click / Peek: baris key di file Environment aktif (atau Globals); editor tabel menyorot key itu */
  const definition: vscode.DefinitionProvider = {
    async provideDefinition(doc, pos) {
      const t = tokenAt(doc, pos);
      if (!t || t.name.startsWith('$')) return undefined;
      if (isHttp(doc) && fileVariables(doc.getText()).has(t.name)) {
        const m = new RegExp(`^[ \\t]*@${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*=`, 'm').exec(doc.getText());
        return m ? new vscode.Location(doc.uri, doc.positionAt(m.index + m[0].indexOf('@'))) : undefined;
      }
      const c = await context();
      const active = c.environments.find((e) => e.name === c.active);
      const globals = c.globals.has(t.name) && (!active?.values.has(t.name) || (active.values.get(t.name) === null && typeof c.globals.get(t.name) === 'string'));
      const uri = globals ? envs.globalsUri : active ? envs.uriOf(active.name) : undefined;
      if (!uri) return undefined;
      const values = globals ? c.globals : active!.values;
      await focusVariable(uri, t.name, !values.has(t.name) ? 'add' : values.get(t.name) === null ? 'fill' : 'show', false);
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const at = findKeyInJson(vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())?.getText() ?? text, t.name);
        const target = await vscode.workspace.openTextDocument(uri);
        return new vscode.Location(uri, at ? rangeOf(target, at) : new vscode.Position(0, 0));
      } catch (e) {
        log().error(errorLine('variables.definition', e)); // file Environment belum ada / tidak terbaca: tidak ada lokasi
        return undefined;
      }
    },
  };

  const references: vscode.ReferenceProvider = {
    async provideReferences(doc, pos) {
      const t = tokenAt(doc, pos);
      if (!t) return [];
      const files = await vscode.workspace.findFiles('{**/*.http,**/pre-request.js,**/post-request.js}', '**/node_modules/**', 5000);
      const texts = await Promise.all(files.map(async (u) => ({
        path: u.toString(),
        text: vscode.workspace.textDocuments.find((d) => d.uri.toString() === u.toString())?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(u)).toString('utf8'),
      })));
      if (doc.uri.scheme !== 'file') texts.push({ path: doc.uri.toString(), text: doc.getText() });
      const opened = new Map<string, vscode.TextDocument>();
      const out: vscode.Location[] = [];
      for (const r of findReferences(texts.map((x) => ({ ...x, path: x.path })), t.name)) {
        const uri = vscode.Uri.parse(r.path);
        const d = opened.get(r.path) ?? (await vscode.workspace.openTextDocument(uri));
        opened.set(r.path, d);
        out.push(new vscode.Location(uri, rangeOf(d, r)));
      }
      return out;
    },
  };

  const completion: vscode.CompletionItemProvider = {
    async provideCompletionItems(doc, pos) {
      const before = doc.lineAt(pos.line).text.slice(0, pos.character);
      const m = /\{\{\s*([\w.$-]*)$/.exec(before);
      if (!m) return undefined;
      const after = doc.lineAt(pos.line).text.slice(pos.character);
      const close = after.startsWith('}}') ? '' : '}}';
      const c = await context();
      const file = isHttp(doc) ? fileVariables(doc.getText()) : new Map<string, string>();
      const active = c.environments.find((e) => e.name === c.active);
      const range = new vscode.Range(pos.translate(0, -m[1].length), pos);
      return completionNames(c, file).map((name) => {
        const v = file.get(name) ?? active?.values.get(name) ?? c.globals.get(name);
        const secret = active?.secret.has(name) || c.globalSecret?.has(name);
        const item = new vscode.CompletionItem(name, name.startsWith('$') ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Variable);
        item.detail = name.startsWith('$') ? 'Dynamic variable' : v === null ? 'NULL' : secret ? '••••' : v;
        item.insertText = name + close;
        item.range = range;
        return item;
      });
    },
  };

  return vscode.Disposable.from(
    collection,
    envs.onDidChange(() => { ctx = undefined; checkAll(); }),
    vscode.workspace.onDidOpenTextDocument((d) => later(d)),
    vscode.workspace.onDidChangeTextDocument((e) => { if (e.contentChanges.length) later(e.document); }),
    vscode.workspace.onDidCloseTextDocument((d) => { collection.delete(d.uri); clearTimeout(timers.get(d.uri.toString())); }),
    vscode.languages.registerCodeActionsProvider(selector, quickFix, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerHoverProvider(selector, hover),
    vscode.languages.registerDefinitionProvider(selector, definition),
    vscode.languages.registerReferenceProvider(selector, references),
    vscode.languages.registerCompletionItemProvider(selector, completion, '{'),
    new vscode.Disposable(() => timers.forEach((t) => clearTimeout(t))),
  );
}
