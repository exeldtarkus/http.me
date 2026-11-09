import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ITests } from './it/index';

const labels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));

export const tests: ITests = {
  async 'Open Dashboard membuka satu tab ringkasan Collections / Environments / Cookies'() {
    await vscode.commands.executeCommand('httpme.openDashboard');
    for (let i = 0; i < 30 && !labels().includes('http.me Dashboard'); i++) await new Promise((r) => setTimeout(r, 100)); // tab muncul async
    assert.ok(labels().includes('http.me Dashboard'), labels().join(', '));
    await vscode.commands.executeCommand('httpme.openDashboard'); // kedua kali: tab yang sama
    assert.equal(labels().filter((l) => l === 'http.me Dashboard').length, 1);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  },
  async 'Back to Dashboard membuka / menampilkan kembali Dashboard'() {
    await new Promise((r) => setTimeout(r, 300)); // dispose panel dari test sebelumnya
    await vscode.commands.executeCommand('httpme.backToDashboard');
    for (let i = 0; i < 30 && !labels().includes('http.me Dashboard'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(labels().includes('http.me Dashboard'), labels().join(', '));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  },
};
