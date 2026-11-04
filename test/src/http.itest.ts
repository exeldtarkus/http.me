import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { send } from '../../src/http';
import type { ITests } from './it/index';

export const tests: ITests = {
  async 'QUERY + body terkirim dari extension host (Node milik VS Code)'() {
    let first = '';
    // server net mentah: menerima method apa pun walau parser HTTP Node lama belum mengenal QUERY
    const srv = net.createServer((sock) => {
      sock.once('data', (d) => {
        first = d.toString('latin1');
        sock.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      });
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    try {
      const port = (srv.address() as net.AddressInfo).port;
      const res = await send({ method: 'QUERY', url: `http://127.0.0.1:${port}/search`, headers: [['Content-Type', 'application/json']], body: '{"q":1}' });
      console.log(`  VS Code ${vscode.version}, Node ${process.versions.node}`);
      assert.match(first, /^QUERY \/search HTTP\/1\.1\r\n/);
      assert.match(first, /\r\n\r\n\{"q":1\}$/);
      assert.equal(res.status, 200);
      assert.equal(res.body.toString(), 'ok');
    } finally {
      srv.close();
    }
  },
  async 'file .http dibuka di panel request (Open With http.me Request)'() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const uri = vscode.Uri.file(join(folder, 'get.http'));
    await vscode.commands.executeCommand('vscode.openWith', uri, 'httpme.request');
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputCustom, 'tab aktif bukan custom editor');
    assert.equal(input.viewType, 'httpme.request');
    assert.equal(input.uri.fsPath, uri.fsPath);
  },
};
