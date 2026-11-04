// CodeLens di editor teks .http: ▶ Send per blok, ⟳ Sending… / ■ Cancel saat jalan, hasil (klik = Show Response), ▶ Send All / ■ Cancel All
import * as vscode from 'vscode';
import { splitBlocks } from './httpFile';
import { isRunning, onRunnerChange, viewOf } from './requestEditor';

export const HTTP_FILES: vscode.DocumentSelector = [{ language: 'http' }, { pattern: '**/*.http' }];

export class RequestLenses implements vscode.CodeLensProvider {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private sub = onRunnerChange(() => this.changed.fire());

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const blocks = splitBlocks(doc.getText());
    const uri = doc.uri.toString();
    const multi = blocks.length > 1;
    const lens = (line: number, title: string, command: string, ...args: unknown[]) =>
      new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title, command, arguments: args });
    const out: vscode.CodeLens[] = [];
    const keys = blocks.map((_b, i) => (multi ? `${uri}#${i}` : uri));
    if (multi) {
      out.push(lens(0, `▶ Send All (${blocks.length})`, 'httpme.sendAll', doc.uri));
      if (keys.some(isRunning)) out.push(lens(0, '■ Cancel All', 'httpme.cancelFile', doc.uri));
    }
    blocks.forEach((b, i) => {
      const v = viewOf(keys[i]);
      if (v?.kind === 'running' || v?.kind === 'queued') {
        out.push(lens(b.start, v.kind === 'queued' ? `$(clock) ${v.position}` : '$(sync~spin) Sending…', 'httpme.showRunning'));
        out.push(lens(b.start, '■ Cancel', 'httpme.cancelBlock', doc.uri, i));
        return;
      }
      out.push(lens(b.start, '▶ Send', 'httpme.sendBlock', doc.uri, i));
      if (v?.kind === 'response') out.push(lens(b.start, `${v.status} · ${v.time} · ${v.size}`, 'httpme.showResponse', keys[i]));
      else if (v?.kind === 'error') out.push(lens(b.start, `✕ ${v.message.slice(0, 80)}`, 'httpme.showLog'));
      else if (v?.kind === 'cancelled') out.push(lens(b.start, 'Cancelled', 'httpme.sendBlock', doc.uri, i));
    });
    return out;
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}
