import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ITests } from './it/index';

const labels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));

export const tests: ITests = {
  async 'Open Dashboard membuka satu tab ringkasan Collections / Environments / Cookies'() {
    await vscode.commands.executeCommand('httpme.openDashboard');
    assert.ok(labels().includes('http.me Dashboard'), labels().join(', '));
    await vscode.commands.executeCommand('httpme.openDashboard'); // kedua kali: tab yang sama
    assert.equal(labels().filter((l) => l === 'http.me Dashboard').length, 1);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  },
};
