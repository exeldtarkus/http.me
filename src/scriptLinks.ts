// path di baris `< ./x.js` / `> ./x.js` / `< ./body.json` (lem tipis): link Ctrl+Click, F12, hover isi awal file,
// path tidak ada = diagnostics + Quick Fix Create file, autocomplete path .js, rename script = tawaran update .http
import * as vscode from 'vscode';
import { dirname } from 'node:path';
import { relScriptPath, renameEdits, scriptPaths, scriptTemplate, sidecarMoves, type PathRef } from './scripts';
import { HTTP_FILES } from './codelens';
import { errMsg, errorLine } from './log';
import { log, reportError } from './output';

const HOVER_LINES = 10;

/** path relatif ke folder .http; dokumen untitled tidak punya folder */
const targetOf = (doc: vscode.TextDocument, p: PathRef) =>
  doc.uri.scheme === 'untitled' ? undefined : vscode.Uri.joinPath(doc.uri, '..', p.path);
const rangeOf = (p: PathRef) => new vscode.Range(p.line, p.start, p.line, p.end);
const at = (doc: vscode.TextDocument, pos: vscode.Position) =>
  scriptPaths(doc.getText()).find((p) => p.line === pos.line && pos.character >= p.start && pos.character <= p.end);

const exists = (u: vscode.Uri) => vscode.workspace.fs.stat(u).then(() => true, () => false);

/** diagnostics path: tidak ada / berkoma (code = jenis baris, dipakai Quick Fix) */
async function diagnose(doc: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
  const out: vscode.Diagnostic[] = [];
  for (const p of scriptPaths(doc.getText())) {
    const target = targetOf(doc, p);
    if (!target) continue;
    const comma = p.kind !== 'body' && p.path.includes(',');
    if (!comma && (await exists(target))) continue;
    const label = p.kind === 'body' ? 'Body file' : 'Script file';
    const d = new vscode.Diagnostic(rangeOf(p), comma ? `Use one script path per line: ${p.path}` : `${label} not found: ${p.path} (${vscode.workspace.asRelativePath(target)})`, vscode.DiagnosticSeverity.Error);
    d.source = 'http.me';
    d.code = comma ? 'comma' : `missing-${p.kind}`;
    out.push(d);
  }
  return out;
}

/** rename / pindah file atau folder: .http yang menyebutnya ditawari update baris < / > */
async function renameParticipant(e: vscode.FileWillRenameEvent): Promise<vscode.WorkspaceEdit> {
  const edit = new vscode.WorkspaceEdit();
  const files = await vscode.workspace.findFiles('**/*.http', '**/node_modules/**', 5000);
  let count = 0;
  for (const u of files) {
    if (e.files.some((f) => f.oldUri.toString() === u.toString())) continue;
    const doc = await vscode.workspace.openTextDocument(u);
    let hit = false;
    for (const f of e.files) {
      for (const x of renameEdits(doc.getText(), dirname(u.fsPath), f.oldUri.fsPath, f.newUri.fsPath)) {
        edit.replace(u, new vscode.Range(x.line, x.start, x.line, x.end), x.text);
        hit = true;
      }
    }
    if (hit) count++;
  }
  if (!count) return edit;
  const name = e.files.length === 1 ? e.files[0].oldUri.path.split('/').pop() : `${e.files.length} files`;
  const pick = await vscode.window.showInformationMessage(`Update ${count} .http file${count === 1 ? '' : 's'} that reference ${name}?`, { modal: true }, 'Update');
  return pick === 'Update' ? edit : new vscode.WorkspaceEdit();
}

export function registerScriptLinks(): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('http.me scripts');
  const isHttp = (d: vscode.TextDocument) => d.languageId === 'http' || /\.http$/i.test(d.uri.path);
  const check = (d: vscode.TextDocument) => {
    if (!isHttp(d)) return;
    void diagnose(d).then((x) => collection.set(d.uri, x), (e) => log().error(errorLine('scriptLinks.diagnose', e)));
  };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const later = (d: vscode.TextDocument) => {
    const k = d.uri.toString();
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => { timers.delete(k); check(d); }, 300));
  };
  vscode.workspace.textDocuments.forEach(check);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  const recheck = () => vscode.workspace.textDocuments.forEach(later);

  const quickFix: vscode.CodeActionProvider = {
    provideCodeActions(doc, _range, cx) {
      return cx.diagnostics.filter((d) => d.source === 'http.me' && typeof d.code === 'string' && d.code.startsWith('missing-')).flatMap((d) => {
        const p = at(doc, d.range.start);
        const target = p && targetOf(doc, p);
        if (!target) return [];
        const a = new vscode.CodeAction(`Create file ${p.path}`, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.command = { title: a.title, command: 'httpme.createScriptFile', arguments: [target, p.kind] };
        return [a];
      });
    },
  };

  /** setelah `< ` / `> `: file .js di workspace, path relatif ke .http */
  const completion: vscode.CompletionItemProvider = {
    async provideCompletionItems(doc, pos) {
      const before = doc.lineAt(pos.line).text.slice(0, pos.character);
      const m = /^\s*[<>]\s+(\S*)$/.exec(before);
      if (!m || m[1].startsWith('{') || doc.uri.scheme === 'untitled') return undefined;
      const range = new vscode.Range(pos.translate(0, -m[1].length), pos);
      const dir = dirname(doc.uri.fsPath);
      const files = await vscode.workspace.findFiles('**/*.js', '**/node_modules/**', 500);
      return files.map((u) => {
        const item = new vscode.CompletionItem(relScriptPath(dir, u.fsPath), vscode.CompletionItemKind.File);
        item.range = range;
        return item;
      });
    },
  };

  const links: vscode.DocumentLinkProvider = {
    provideDocumentLinks: (doc) => scriptPaths(doc.getText()).flatMap((p) => {
      const target = targetOf(doc, p);
      if (!target) return [];
      const link = new vscode.DocumentLink(rangeOf(p), target);
      link.tooltip = p.kind === 'body' ? 'Open body file' : 'Open script';
      return [link];
    }),
  };
  const definition: vscode.DefinitionProvider = {
    provideDefinition(doc, pos) {
      const p = at(doc, pos);
      const target = p && targetOf(doc, p);
      return target ? new vscode.Location(target, new vscode.Position(0, 0)) : undefined;
    },
  };
  const hover: vscode.HoverProvider = {
    async provideHover(doc, pos) {
      const p = at(doc, pos);
      const target = p && targetOf(doc, p);
      if (!target) return undefined;
      const md = new vscode.MarkdownString();
      md.appendText(target.fsPath);
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
        md.appendCodeblock(text.split('\n').slice(0, HOVER_LINES).join('\n'), p.kind === 'body' ? '' : 'javascript');
      } catch (e) {
        log().error(errorLine('scriptLinks.hover', e)); // file belum ada: hover hanya path
        md.appendMarkdown('\n\n*File not found*');
      }
      return new vscode.Hover(md, rangeOf(p));
    },
  };
  return vscode.Disposable.from(
    collection,
    vscode.workspace.onDidOpenTextDocument(later),
    vscode.workspace.onDidChangeTextDocument((e) => { if (e.contentChanges.length) later(e.document); }),
    vscode.workspace.onDidCloseTextDocument((d) => { collection.delete(d.uri); clearTimeout(timers.get(d.uri.toString())); }),
    // file dibuat / dihapus (Quick Fix, terminal, git): cek ulang dokumen .http yang terbuka
    watcher, watcher.onDidCreate(recheck), watcher.onDidDelete(recheck),
    vscode.workspace.onDidRenameFiles((e) => {
      vscode.workspace.textDocuments.forEach(later);
      // script milik request (page.pre-request.js) ikut rename / pindah .http
      for (const f of e.files) {
        for (const [from, to] of sidecarMoves(f.oldUri.fsPath, f.newUri.fsPath)) {
          const src = vscode.Uri.file(from);
          void exists(src).then(async (ok) => { if (ok) await vscode.workspace.fs.rename(src, vscode.Uri.file(to)); })
            .then(undefined, (err) => reportError('scriptLinks.moveOwnScript', err, `Could not move ${from}: ${errMsg(err)}`));
        }
      }
    }),
    // script milik request dikosongkan lalu disimpan = dihapus (folder pre-request.js tidak)
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (!/[^/\\]\.(pre|post)-request\.js$/i.test(d.uri.path) || d.getText().trim() !== '') return;
      void vscode.workspace.fs.delete(d.uri).then(undefined, (err) => log().error(errorLine('scriptLinks.deleteEmpty', err)));
    }),
    vscode.workspace.onWillRenameFiles((e) => e.waitUntil(renameParticipant(e).catch((err) => {
      log().error(errorLine('scriptLinks.rename', err));
      return new vscode.WorkspaceEdit();
    }))),
    vscode.commands.registerCommand('httpme.createScriptFile', async (target: vscode.Uri, kind: PathRef['kind']) => {
      try {
        await vscode.workspace.fs.writeFile(target, Buffer.from(kind === 'body' ? '' : scriptTemplate(kind)));
        await vscode.window.showTextDocument(target);
      } catch (e) {
        reportError('createScriptFile', e, `Could not create ${target.fsPath}: ${errMsg(e)}`);
      }
    }),
    vscode.languages.registerCodeActionsProvider(HTTP_FILES, quickFix, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerCompletionItemProvider(HTTP_FILES, completion, ' ', '/', '.'),
    new vscode.Disposable(() => timers.forEach((t) => clearTimeout(t))),
    vscode.languages.registerDocumentLinkProvider(HTTP_FILES, links),
    vscode.languages.registerDefinitionProvider(HTTP_FILES, definition),
    vscode.languages.registerHoverProvider(HTTP_FILES, hover),
  );
}
