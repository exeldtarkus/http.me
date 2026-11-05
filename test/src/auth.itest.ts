import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { AuthConfig } from '../../src/auth';
import * as httpEditor from '../../src/httpEditor';
import { parseRequest, type ParsedRequest } from '../../src/httpFile';
import type { ITests } from './it/index';

const resolveRequestAuth = (httpEditor as unknown as {
  resolveRequestAuth?: (uri: vscode.Uri, request: ParsedRequest) => Promise<AuthConfig>;
}).resolveRequestAuth;
const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

export const tests: ITests = {
  async 'Authorization UI exposes every auth type, keeps only compatible fields, and folds Advanced configuration'() {
    const extension = vscode.extensions.getExtension('exeltarkus.httpme')!;
    const ui = require(join(extension.extensionPath, 'media', 'webview', 'panel.js')) as {
      authForms?: { type: string; fields: { name: string; advanced?: boolean }[] }[];
      switchAuthType?: (auth: { type: string; fields: Record<string, string> }, type: string) => { type: string; fields: Record<string, string> };
    };
    assert.ok(ui.authForms, 'the request panel exports its auth form catalog');
    assert.ok(ui.switchAuthType, 'the request panel exports the auth type switcher');
    assert.deepEqual(ui.authForms.map((x) => x.type), ['inherit', 'none', 'apiKey', 'basic', 'bearer', 'digest', 'hawk', 'jwt', 'oauth1', 'oauth2', 'aws']);
    assert.deepEqual(ui.switchAuthType(
      { type: 'basic', fields: { username: 'alice', password: 'pass', token: 'unrelated' } },
      'digest',
    ), { type: 'digest', fields: { username: 'alice', password: 'pass' } });
    assert.deepEqual(ui.switchAuthType(
      { type: 'apiKey', fields: { key: 'X-Key', value: 'raw', in: 'header' } },
      'bearer',
    ), { type: 'bearer', fields: {} });
    assert.ok(ui.authForms.find((x) => x.type === 'digest')?.fields.some((x) => x.name === 'realm' && x.advanced));
    const html = readFileSync(join(extension.extensionPath, 'media', 'webview', 'panel.html'), 'utf8');
    assert.match(html, /data-p="auth"/);
    assert.match(html, /id="p-auth"/);
  },
  async 'Authorization UI warns for raw secrets but not Environment variable references'() {
    const extension = vscode.extensions.getExtension('exeltarkus.httpme')!;
    const ui = require(join(extension.extensionPath, 'media', 'webview', 'panel.js')) as {
      isRawAuthSecret?: (type: string, field: string, value: string) => boolean;
    };
    assert.ok(ui.isRawAuthSecret, 'the request panel exports the raw-secret warning check');
    assert.equal(ui.isRawAuthSecret('bearer', 'token', 'literal-token'), true);
    assert.equal(ui.isRawAuthSecret('bearer', 'token', '{{accessToken}}'), false);
    assert.equal(ui.isRawAuthSecret('basic', 'username', 'alice'), false);
  },
  async 'Authorization messages validate form data and move raw secrets into SecretStorage without echoing them'() {
    await vscode.commands.executeCommand('httpme.whatsNew');
    const extension = vscode.extensions.getExtension('exeltarkus.httpme')!;
    const api = extension.exports as {
      authCall?: (uri: vscode.Uri, message: Record<string, unknown>) => Promise<unknown[]>;
      envs: {
        active: string | undefined;
        names(): Promise<string[]>;
        write(name: string, vars: { key: string; value: string | null; secret?: boolean }[]): Promise<void>;
        vars(name: string): Promise<{ key: string; value: string | null; secret?: boolean }[]>;
        secret(env: string, key: string): Thenable<string | undefined>;
        setSecret(env: string, key: string, value: string | undefined): Promise<void>;
        setActive(name: string | undefined): Promise<void>;
      };
    };
    assert.ok(api.authCall, 'the extension exposes the same auth message handler used by the panel');
    const envName = 'zz-itest-auth-ui';
    const envUri = vscode.Uri.file(join(root(), '.httpme', 'environments', `${envName}.json`));
    const dir = join(root(), 'zz-itest-auth-ui');
    const request = join(dir, 'request.http');
    const uri = vscode.Uri.file(request);
    const secret = 'raw-auth-ui-secret';
    assert.ok(!(await api.envs.names()).includes(envName), 'the test Environment must not overwrite existing data');
    mkdirSync(dir, { recursive: true });
    await api.envs.write(envName, []);
    await api.envs.setActive(envName);
    writeFileSync(request, 'GET https://api.example.com/private\n');
    try {
      await assert.rejects(api.authCall(uri, { type: 'authChange', index: 0, auth: { type: 'bearer', fields: { token: 42 } } }), /Invalid Authorization form/);
      assert.equal(readFileSync(request, 'utf8'), 'GET https://api.example.com/private\n');
      const reply = await api.authCall(uri, {
        type: 'authMoveToSecret', index: 0,
        auth: { type: 'bearer', fields: { token: secret } },
        field: 'token', name: 'accessToken',
      });
      assert.equal(await api.envs.secret(envName, 'accessToken'), secret);
      assert.deepEqual((await api.envs.vars(envName)).find((x) => x.key === 'accessToken'), { key: 'accessToken', value: null, secret: true });
      assert.match(readFileSync(request, 'utf8'), /# @auth bearer token=\{\{accessToken\}\}/);
      assert.ok(!JSON.stringify(reply).includes(secret), 'host replies never include the secret value');
      assert.ok(!readFileSync(envUri.fsPath, 'utf8').includes(secret), 'secret values are absent from Environment files');
    } finally {
      await api.envs.setSecret(envName, 'accessToken', undefined);
      await api.envs.setActive(undefined);
      if (existsSync(envUri.fsPath)) await vscode.workspace.fs.delete(envUri, { useTrash: false });
      rmSync(dir, { recursive: true, force: true });
    }
  },
  async 'auth resolves nearest folder, request override, No Auth, and missing config'() {
    const root = join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'zz-itest-auth-inheritance');
    const nested = join(root, 'nested');
    const requestDir = join(nested, 'requests');
    const file = join(requestDir, 'request.http');
    mkdirSync(requestDir, { recursive: true });
    writeFileSync(join(root, '_auth.http'), '# @auth bearer token=root-token\n');
    writeFileSync(join(nested, '_auth.http'), '# @auth basic username=nested password=nested-pass\n');
    const uri = vscode.Uri.file(file);
    try {
      assert.ok(resolveRequestAuth, 'the editor adapter exports the auth resolver');
      assert.deepEqual(await resolveRequestAuth(uri, parseRequest('GET https://a.test/one\n')), {
        type: 'basic', fields: { username: 'nested', password: 'nested-pass' },
      }, 'the nearest ancestor config wins over its parent');
      assert.deepEqual(await resolveRequestAuth(uri, parseRequest('# @auth bearer token=request-token\nGET https://a.test/one\n')), {
        type: 'bearer', fields: { token: 'request-token' },
      }, 'request-level auth overrides folder auth');
      assert.deepEqual(await resolveRequestAuth(uri, parseRequest('# @auth none\nGET https://a.test/one\n')), {
        type: 'none', fields: {},
      }, 'explicit No Auth disables inherited auth');
      rmSync(join(nested, '_auth.http'));
      rmSync(join(root, '_auth.http'));
      assert.deepEqual(await resolveRequestAuth(uri, parseRequest('GET https://a.test/one\n')), {
        type: 'inherit', fields: {},
      }, 'missing folder configs leave auth inherited');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
};
