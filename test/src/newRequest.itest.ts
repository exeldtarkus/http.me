import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ITests } from './it/index';

const activeCustom = () => {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(input instanceof vscode.TabInputCustom, `tab aktif bukan custom editor: ${JSON.stringify(input)}`);
  return input;
};

export const tests: ITests = {
  async 'New Request membuka tab .http untitled di panel request'() {
    await vscode.commands.executeCommand('httpme.newRequest');
    const tab = activeCustom();
    assert.equal(tab.viewType, 'httpme.request');
    assert.equal(tab.uri.scheme, 'untitled');
    assert.match(tab.uri.path, /New Request 1\.http$/);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === tab.uri.toString());
    assert.equal(doc?.getText(), 'GET https://\n');
  },
  async 'New Request kedua memakai nomor berikutnya'() {
    await vscode.commands.executeCommand('httpme.newRequest');
    assert.match(activeCustom().uri.path, /New Request 2\.http$/);
  },
};
