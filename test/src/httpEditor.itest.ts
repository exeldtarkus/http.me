import * as assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ITests } from './it/index';

type Api = { applyPanelEdit(uri: vscode.Uri, req: unknown): Promise<void> };
const api = () => vscode.extensions.getExtension<Api>('exeltarkus.httpme')!.exports;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export const tests: ITests = {
  async 'edit dari panel = WorkspaceEdit: dokumen dirty, undo kembali, save menulis file'() {
    const file = join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'zz-itest-editor.http');
    writeFileSync(file, 'GET https://a.test/one\n');
    const uri = vscode.Uri.file(file);
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'httpme.request');
      const doc = await vscode.workspace.openTextDocument(uri);
      const { parseRequest } = await import('../../src/httpFile');
      await api().applyPanelEdit(uri, { ...parseRequest(doc.getText()), url: 'https://a.test/two' });
      assert.equal(doc.getText(), 'GET https://a.test/two\n');
      assert.equal(doc.isDirty, true);
      await vscode.commands.executeCommand('undo');
      await wait(100);
      assert.equal(doc.getText(), 'GET https://a.test/one\n', 'undo VS Code membatalkan edit panel');
      await vscode.commands.executeCommand('redo');
      await wait(100);
      assert.equal(await doc.save(), true);
      assert.equal(doc.isDirty, false);
      assert.equal(readFileSync(file, 'utf8'), 'GET https://a.test/two\n');
      // edit teks dari luar (editor teks / git) -> dokumen yang sama dipakai panel
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(0, 0, 0, 3), 'POST');
      await vscode.workspace.applyEdit(edit);
      assert.equal(parseRequest(doc.getText()).method, 'POST');
      await vscode.commands.executeCommand('workbench.action.files.revert');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      rmSync(file, { force: true });
    }
  },
};
