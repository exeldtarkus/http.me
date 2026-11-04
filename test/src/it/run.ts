// npm run test:it: jalankan *.itest.js di VS Code sungguhan (@vscode/test-electron), workspace = test-extension/
import { runTests } from '@vscode/test-electron';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..', '..');
// dari terminal VS Code variabel ini ikut terwarisi dan membuat Electron jalan sebagai Node biasa
delete process.env.ELECTRON_RUN_AS_NODE;

runTests({
  version: process.env.VSCODE_VERSION ?? 'stable',
  extensionDevelopmentPath: root,
  extensionTestsPath: join(__dirname, 'index.js'),
  extensionTestsEnv: process.env.ITEST ? { ITEST: process.env.ITEST } : undefined,
  launchArgs: [join(root, 'test-extension'), '--disable-extensions', '--disable-workspace-trust'],
}).catch((e) => {
  console.error(`test:it - EXCEPTION CAUGHT | ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
