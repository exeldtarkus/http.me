// output channel "http.me" (lem tipis ke VS Code); format pesan ada di log.ts
import * as vscode from 'vscode';
import { errorLine } from './log';

let channel: vscode.LogOutputChannel | undefined;

/** dibuat saat dipakai pertama kali (aktivasi malas) */
export const log = (): vscode.LogOutputChannel => (channel ??= vscode.window.createOutputChannel('http.me', { log: true }));

/** catat ERROR + stack trace, lalu notifikasi error dengan tombol Show Log */
export function reportError(where: string, e: unknown, message: string): void {
  log().error(errorLine(where, e));
  void vscode.window.showErrorMessage(message, 'Show Log').then((pick) => { if (pick) log().show(true); });
}
