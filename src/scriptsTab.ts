// tab Scripts panel request (lem tipis VS Code): Runs in order, editor script, + Add script, ✕, urutan, Save.
// Isi script = TextDocument VS Code (dirty / undo / sinkron dengan editor teks); baris < / > ditulis ke .http lewat WorkspaceEdit.
import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseRequest, serializeRequest, splitBlocks } from './httpFile';
import { chainItems, moveItem, relScriptPath, scriptTemplate, withScriptLines, type ChainItem, type ScriptKind } from './scripts';
import { SNIPPETS } from './scriptSnippets';

export type ScriptsMessage = { type: string; kind?: unknown; path?: unknown; text?: unknown; from?: unknown; to?: unknown; choice?: unknown; target?: unknown };
type Post = (m: unknown) => void;

const KINDS: ScriptKind[] = ['pre', 'post'];
const isKind = (k: unknown): k is ScriptKind => k === 'pre' || k === 'post';
const rootOf = (doc: vscode.TextDocument) => vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? dirname(doc.uri.fsPath);
const openDoc = (file: string) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file);
const exists = (f: string) => fs.access(f).then(() => true, () => false);

/** item untuk webview: label relatif ke .http, ● bila dokumen belum disimpan */
async function items(doc: vscode.TextDocument, kind: ScriptKind): Promise<(ChainItem & { label: string; dirty: boolean })[]> {
  const list = await chainItems(rootOf(doc), doc.uri.fsPath, parseRequest(doc.getText()), kind);
  const dir = dirname(doc.uri.fsPath);
  return list.map((x) => ({
    ...x,
    label: x.source === 'own' ? 'This request' : x.source === 'inline' ? 'inline {% %}' : relScriptPath(dir, x.file),
    dirty: !!x.file && !!openDoc(x.file)?.isDirty,
  }));
}

/** state tab Scripts: rantai pre / post + pratinjau baris .http */
export async function scriptsState(doc: vscode.TextDocument): Promise<unknown> {
  if (doc.uri.scheme !== 'file' || splitBlocks(doc.getText()).length > 1) return { type: 'scripts', available: false };
  const [pre, post] = await Promise.all(KINDS.map((k) => items(doc, k)));
  const name = doc.uri.path.split('/').pop();
  const r = parseRequest(doc.getText());
  const preview = [...r.preScripts.filter((x) => !x.startsWith('{%')).map((p) => `${name}: < ${p}`), ...r.postScripts.filter((x) => !x.startsWith('{%')).map((p) => `${name}: > ${p}`)];
  const own = [...pre, ...post].some((x) => x.source === 'own' && x.exists) || r.preScripts.length + r.postScripts.length > 0;
  return { type: 'scripts', available: true, pre, post, preview, dirty: doc.isDirty, own, snippets: SNIPPETS };
}

/** dokumen script: yang terbuka, file yang ada, atau file baru (dibuat saat pertama diketik) */
async function scriptDoc(file: string, create: boolean): Promise<vscode.TextDocument | undefined> {
  const open = openDoc(file);
  if (open) return open;
  if (!(await exists(file))) {
    if (!create) return undefined;
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, '');
  }
  return vscode.workspace.openTextDocument(vscode.Uri.file(file));
}

/** path script dari webview harus salah satu item rantai request ini (bukan path sembarang) */
async function known(doc: vscode.TextDocument, file: unknown): Promise<string | undefined> {
  if (typeof file !== 'string' || !file) return undefined;
  const all = [...(await items(doc, 'pre')), ...(await items(doc, 'post'))];
  return all.some((x) => x.file === file) ? file : undefined;
}

async function writeLines(doc: vscode.TextDocument, kind: ScriptKind, files: string[]): Promise<void> {
  const text = serializeRequest(withScriptLines(parseRequest(doc.getText()), kind, dirname(doc.uri.fsPath), files));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error('Could not update the script lines in the .http file');
}
const lineFiles = async (doc: vscode.TextDocument, kind: ScriptKind) => (await items(doc, kind)).filter((x) => x.source === 'line').map((x) => x.file);

/** valid: path .js relatif ke workspace, tanpa `..` / koma, belum ada */
export function newScriptPathError(rel: string): string | undefined {
  const p = rel.trim();
  if (!p.endsWith('.js')) return 'The script file name must end with .js';
  if (p.split(/[\\/]/).includes('..')) return 'Use a path inside the workspace (no ..)';
  if (p.includes(',')) return 'Script file names cannot contain a comma';
  return undefined;
}

/** + Add script: New script file… / Add existing script… / Create folder script (choice / target dari itest melewati UI) */
async function addScript(doc: vscode.TextDocument, kind: ScriptKind, choice?: unknown, target?: unknown): Promise<string | undefined> {
  const root = rootOf(doc);
  const dir = dirname(doc.uri.fsPath);
  const pick = typeof choice === 'string' ? choice : (await vscode.window.showQuickPick(['New script file…', 'Add existing script…', 'Create folder script'], { placeHolder: 'Add a script' }));
  if (pick === 'New script file…') {
    const start = relative(root, dir).split(sep).join('/');
    const rel = typeof target === 'string' ? target : await vscode.window.showInputBox({
      prompt: 'New script file (path in the workspace)', value: `${start ? `${start}/` : ''}scripts/${kind === 'pre' ? 'before' : 'after'}.js`,
      validateInput: async (v) => newScriptPathError(v) ?? ((await exists(resolve(root, v.trim()))) ? 'This file already exists' : undefined),
    });
    if (!rel) return undefined;
    const err = newScriptPathError(rel) ?? ((await exists(resolve(root, rel.trim()))) ? 'This file already exists' : undefined);
    if (err) throw new Error(err);
    const file = resolve(root, rel.trim());
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, scriptTemplate(kind));
    await writeLines(doc, kind, [...(await lineFiles(doc, kind)), file]);
    return file;
  }
  if (pick === 'Add existing script…') {
    let file = typeof target === 'string' ? resolve(root, target) : undefined;
    if (!file) {
      const uris = await vscode.workspace.findFiles('**/*.js', '**/node_modules/**', 2000);
      const p = await vscode.window.showQuickPick(uris.map((u) => ({ label: relScriptPath(dir, u.fsPath), file: u.fsPath })), { placeHolder: 'Script to run for this request' });
      file = p?.file;
    }
    if (!file) return undefined;
    const lines = await lineFiles(doc, kind);
    if (!lines.includes(file)) await writeLines(doc, kind, [...lines, file]);
    return file;
  }
  if (pick === 'Create folder script') {
    const chain: string[] = [];
    for (let d = dir; ; d = dirname(d)) { chain.unshift(d); if (d === root || !d.startsWith(root + sep)) break; }
    const folder = typeof target === 'string' ? resolve(root, target) : (await vscode.window.showQuickPick(chain.map((d) => ({ label: relative(root, d) || '(workspace root)', description: `${kind}-request.js runs for every request in this folder`, d })), { placeHolder: 'Folder' }))?.d;
    if (!folder) return undefined;
    const file = join(folder, `${kind}-request.js`);
    if (!(await exists(file))) await fs.writeFile(file, scriptTemplate(kind));
    return file;
  }
  return undefined;
}

/** pesan tab Scripts dari webview; false = bukan pesan tab Scripts */
export async function handleScriptsMessage(doc: vscode.TextDocument, m: ScriptsMessage, post: Post): Promise<boolean> {
  const refresh = async () => post(await scriptsState(doc));
  switch (m.type) {
    case 'scriptsGet': await refresh(); return true;
    case 'scriptLoad': {
      const file = await known(doc, m.path);
      if (!file) return true;
      const d = await scriptDoc(file, false);
      post({ type: 'scriptText', path: file, text: d?.getText() ?? '' });
      return true;
    }
    case 'scriptEdit': {
      const file = await known(doc, m.path);
      if (!file || typeof m.text !== 'string') return true;
      const d = await scriptDoc(file, true);
      if (!d || d.getText() === m.text) return true;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(d.uri, new vscode.Range(d.positionAt(0), d.positionAt(d.getText().length)), m.text);
      await vscode.workspace.applyEdit(edit);
      return true;
    }
    case 'scriptOpenEditor': {
      const file = await known(doc, m.path);
      const d = file && (await scriptDoc(file, true));
      if (d) await vscode.window.showTextDocument(d, { viewColumn: vscode.ViewColumn.Beside });
      return true;
    }
    case 'scriptAdd': {
      if (!isKind(m.kind)) return true;
      const file = await addScript(doc, m.kind, m.choice, m.target);
      await refresh();
      if (file) post({ type: 'scriptSelect', path: file });
      return true;
    }
    case 'scriptRemove': {
      if (!isKind(m.kind) || typeof m.path !== 'string') return true;
      await writeLines(doc, m.kind, (await lineFiles(doc, m.kind)).filter((f) => f !== m.path));
      await refresh();
      return true;
    }
    case 'scriptMove': {
      if (!isKind(m.kind) || typeof m.from !== 'number' || typeof m.to !== 'number') return true;
      await writeLines(doc, m.kind, moveItem(await lineFiles(doc, m.kind), m.from, m.to));
      await refresh();
      return true;
    }
    case 'scriptSave': await saveScripts(doc, true); await refresh(); return true;
    default: return false;
  }
}

/** simpan script rantai request yang belum disimpan (+ .http bila withHttp) */
export async function saveScripts(doc: vscode.TextDocument, withHttp: boolean): Promise<void> {
  const files = [...(await items(doc, 'pre')), ...(await items(doc, 'post'))].map((x) => x.file).filter(Boolean);
  for (const f of new Set(files)) { const d = openDoc(f); if (d?.isDirty) await d.save(); }
  if (withHttp && doc.isDirty) await doc.save();
}

/** script milik rantai request ini? (perubahan dokumennya memperbarui tab Scripts) */
export async function isChainFile(doc: vscode.TextDocument, file: string): Promise<boolean> {
  return !!(await known(doc, file));
}
