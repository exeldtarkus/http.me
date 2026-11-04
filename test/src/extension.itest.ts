import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ITests } from './it/index';

const ext = () => vscode.extensions.getExtension('exeltarkus.httpme');

export const tests: ITests = {
  async 'extension aktif lewat command dan mendaftarkan httpme.whatsNew'() {
    assert.ok(ext(), 'extension exeltarkus.httpme tidak ditemukan');
    await vscode.commands.executeCommand('httpme.whatsNew');
    assert.equal(ext()!.isActive, true);
    assert.ok((await vscode.commands.getCommands(true)).includes('httpme.whatsNew'));
  },
};
