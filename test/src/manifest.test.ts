import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// out/test/src → root repo
const root = join(__dirname, '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('identitas extension', () => {
  assert.equal(pkg.name, 'httpme');
  assert.equal(pkg.displayName, 'http.me');
  assert.equal(pkg.publisher, 'exeltarkus');
  assert.match(pkg.repository?.url ?? '', /github\.com\/exeldtarkus\/http\.me/);
});

test('versi SemVer angka saja', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test('engines.vscode ^1.90.0 (Node 20: fetch + Headers.getSetCookie)', () => {
  assert.equal(pkg.engines?.vscode, '^1.90.0');
});

test('aktivasi malas: hanya onCommand / onView', () => {
  assert.ok(Array.isArray(pkg.activationEvents));
  for (const e of pkg.activationEvents) assert.match(e, /^on(Command|View):/);
});

test('tanpa dependency runtime selain yaml', () => {
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(deps.filter((d) => d !== 'yaml'), []);
});

test('main menunjuk ke out/src/extension.js hasil compile', () => {
  assert.equal(pkg.main, './out/src/extension.js');
  assert.ok(existsSync(join(root, pkg.main)), `${pkg.main} belum ada`);
});

test('.vscodeignore mengecualikan test & md, tetap membawa yaml + README', () => {
  const ignore = readFileSync(join(root, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const p of ['test/**', 'out/test/**', '*.md', '!README.md', 'node_modules/**', '!node_modules/yaml/**']) {
    assert.ok(ignore.includes(p), `.vscodeignore tidak berisi ${p}`);
  }
});

test('script install:local + package tersedia', () => {
  assert.equal(pkg.scripts?.['install:local'], 'node scripts/install-local.js');
  assert.equal(pkg.scripts?.package, 'vsce package --skip-license');
  assert.ok(existsSync(join(root, 'scripts', 'install-local.js')), 'scripts/install-local.js belum ada');
});

test('npm run dev membuka Extension Development Host + folder contoh', () => {
  assert.equal(pkg.scripts?.dev, 'npm run compile && bash scripts/dev.sh');
  assert.ok(existsSync(join(root, 'scripts', 'dev.sh')), 'scripts/dev.sh belum ada');
  assert.ok(existsSync(join(root, 'test-extension')), 'folder test-extension/ belum ada');
  const ignore = readFileSync(join(root, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(ignore.includes('test-extension/**'), '.vscodeignore tidak berisi test-extension/**');
});

test('npm run deploy = deploy-v2.sh, --self-test lulus (versi + kanal pre-release/stable)', () => {
  assert.equal(pkg.scripts?.deploy, 'bash scripts/deploy-v2.sh');
  const out = execFileSync('bash', [join(root, 'scripts', 'deploy-v2.sh'), '--self-test'], { encoding: 'utf8' });
  assert.doesNotMatch(out, /FAIL/);
  for (const c of ['0.x pre-release', '1.0 stable', 'odd minor pre-release', 'even minor stable', 'suffix refused']) {
    assert.match(out, new RegExp(`ok +${c}`), `self-test tanpa kasus "${c}"`);
  }
});

test('release.yml memakai kanal dari deploy-v2.sh --channel', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(yml, /deploy-v2\.sh --channel/);
  assert.match(yml, /--pre-release/);
  assert.match(yml, /--prerelease/);
});

test('Workspace Trust: tetap jalan di Restricted Mode (limited), script dilewati', () => {
  assert.equal(pkg.capabilities?.untrustedWorkspaces?.supported, 'limited');
  assert.match(pkg.capabilities.untrustedWorkspaces.description, /scripts/i);
});

test('sidebar welcome: Loading http.me… sebelum aktif, Scanning saat scan, No .http files + New Request', () => {
  const w = (pkg.contributes.viewsWelcome as { view: string; contents: string; when: string }[]).filter((x) => x.view === 'httpme.sidebar');
  const find = (text: string) => w.find((x) => x.contents.startsWith(text));
  assert.match(find('Loading http.me…')?.when ?? '', /!httpme\.loaded/);
  assert.match(find('Scanning the workspace for .http files…')?.when ?? '', /httpme\.loaded && httpme\.scanning/);
  assert.match(find('No .http files.')?.contents ?? '', /\[New Request\]\(command:httpme\.newRequest\)/);
  for (const x of w.filter((y) => y.when.includes('!= empty') && !y.contents.startsWith('Loading'))) assert.match(x.when, /httpme\.loaded/, x.contents);
});

test('review R11: sidebar = 4 section (Collections, Environments, Open, Cookies), toolbar & menu per section', () => {
  const views = pkg.contributes.views.httpme as { id: string; name: string }[];
  assert.deepEqual(views.map((v) => [v.id, v.name]), [
    ['httpme.sidebar', 'Collections'], ['httpme.environments', 'Environments'], ['httpme.open', 'Open'], ['httpme.cookies', 'Cookies'],
  ]);
  type M = { command: string; when: string; group?: string };
  const title = pkg.contributes.menus['view/title'] as M[];
  assert.ok(!title.some((m) => /^httpme\.show(Collections|Environments|Open|Cookies)/.test(m.command)), 'tanpa tombol pindah tab');
  assert.ok(!JSON.stringify(pkg.contributes).includes('sidebarMode'), 'context sidebarMode tidak dipakai lagi');
  const viewOf = (cmd: string) => title.filter((m) => m.command === cmd).map((m) => /view == ([\w.]+)/.exec(m.when)?.[1]);
  assert.deepEqual(viewOf('httpme.add'), ['httpme.sidebar']);
  assert.deepEqual(viewOf('httpme.newEnvironment'), ['httpme.environments']);
  assert.deepEqual(viewOf('httpme.newRequest'), ['httpme.open']);
  assert.deepEqual(viewOf('httpme.addCookie'), ['httpme.cookies']);
  assert.deepEqual(viewOf('httpme.toggleOpenFlat'), ['httpme.open']);
  const item = pkg.contributes.menus['view/item/context'] as M[];
  const expect: [RegExp, string][] = [[/OpenTab/, 'httpme.open'], [/Environment|Globals/, 'httpme.environments'], [/Cookie/, 'httpme.cookies'], [/File|Folder|Root/, 'httpme.sidebar']];
  for (const m of item) {
    const want = expect.find(([re]) => re.test(m.when))![1];
    for (const v of m.when.match(/view == [\w.]+/g) ?? []) assert.equal(v, `view == ${want}`, `${m.command}: ${m.when}`);
  }
  for (const w of pkg.contributes.viewsWelcome as { view: string; contents: string }[]) {
    if (w.contents.startsWith('No open requests')) assert.equal(w.view, 'httpme.open');
  }
});
