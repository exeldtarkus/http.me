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
