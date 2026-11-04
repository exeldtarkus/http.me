import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ITests } from './it/index';

// dijalankan paling awal (nama 00-): sebelum ada command / file http.me dibuka, extension belum aktif = RAM idle ~0
export const tests: ITests = {
  async 'idle: extension belum aktif saat VS Code start'() {
    const ext = vscode.extensions.getExtension('exeltarkus.httpme');
    assert.ok(ext);
    assert.equal(ext.isActive, false);
  },
};
