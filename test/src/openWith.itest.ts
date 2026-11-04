import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ITests } from './it/index';

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const active = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input;

export const tests: ITests = {
  async 'Open in http.me Panel (teks -> panel) dan Open as Text (panel -> teks)'() {
    const uri = vscode.Uri.file(join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'get.http'));
    await vscode.window.showTextDocument(uri);
    assert.ok(active() instanceof vscode.TabInputText);
    await vscode.commands.executeCommand('httpme.openInPanel');
    await wait(100);
    const panel = active();
    assert.ok(panel instanceof vscode.TabInputCustom && panel.viewType === 'httpme.request', 'pindah ke panel');
    await vscode.commands.executeCommand('httpme.openAsText');
    await wait(100);
    const text = active();
    assert.ok(text instanceof vscode.TabInputText && text.uri.fsPath === uri.fsPath, 'kembali ke editor teks');
  },
  async 'tombol title bar terdaftar untuk file .http'() {
    const pkg = vscode.extensions.getExtension('exeltarkus.httpme')!.packageJSON;
    const title = pkg.contributes.menus['editor/title'] as { command: string; when: string }[];
    assert.ok(title.some((m) => m.command === 'httpme.openInPanel' && /resourceExtname == \.http/.test(m.when)));
    assert.ok(title.some((m) => m.command === 'httpme.openAsText' && /activeCustomEditorId == httpme\.request/.test(m.when)));
  },
};
