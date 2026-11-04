// path di baris `< ./x.js` / `> ./x.js` / `< ./body.json` (lem tipis): link Ctrl+Click, F12, hover isi awal file
import * as vscode from 'vscode';
import { scriptPaths, type PathRef } from './scripts';
import { HTTP_FILES } from './codelens';
import { errorLine } from './log';
import { log } from './output';

const HOVER_LINES = 10;

/** path relatif ke folder .http; dokumen untitled tidak punya folder */
const targetOf = (doc: vscode.TextDocument, p: PathRef) =>
  doc.uri.scheme === 'untitled' ? undefined : vscode.Uri.joinPath(doc.uri, '..', p.path);
const rangeOf = (p: PathRef) => new vscode.Range(p.line, p.start, p.line, p.end);
const at = (doc: vscode.TextDocument, pos: vscode.Position) =>
  scriptPaths(doc.getText()).find((p) => p.line === pos.line && pos.character >= p.start && pos.character <= p.end);

export function registerScriptLinks(): vscode.Disposable {
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
    vscode.languages.registerDocumentLinkProvider(HTTP_FILES, links),
    vscode.languages.registerDefinitionProvider(HTTP_FILES, definition),
    vscode.languages.registerHoverProvider(HTTP_FILES, hover),
  );
}
