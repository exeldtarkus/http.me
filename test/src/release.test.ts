import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('Fase 6: icon PNG 128x128, field icon / repository / homepage / bugs, script deploy', () => {
  assert.equal(pkg.icon, 'images/icon.png');
  const png = readFileSync(join(root, pkg.icon));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [128, 128]);
  assert.match(pkg.repository.url, /^https:\/\/github\.com\/[\w-]+\/http\.me\.git$/);
  assert.match(pkg.homepage, /github\.com/);
  assert.match(pkg.bugs.url, /\/issues$/);
  for (const s of ['deploy', 'deploy:token', 'screenshots', 'package']) assert.ok(pkg.scripts[s], s);
  for (const f of ['scripts/deploy-v2.sh', 'scripts/deploy.js', 'scripts/screenshots.js', '.github/workflows/release.yml']) assert.ok(existsSync(join(root, f)), f);
});

test('Fase 6: README EN + ID memakai gambar relatif PNG yang ada, saling menaut, tanpa SVG / emoji bendera', () => {
  for (const [file, other] of [['README.md', 'README.id.md'], ['README.id.md', 'README.md']]) {
    const text = readFileSync(join(root, file), 'utf8');
    const imgs = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
    assert.ok(imgs.length >= 5, `${file}: gambar`);
    for (const i of imgs) { assert.match(i, /^images\/screenshots\/[\w-]+\.png$/, i); assert.ok(existsSync(join(root, i)), i); }
    assert.ok(text.includes(`(${other})`), `${file} menaut ${other}`);
    assert.doesNotMatch(text, /[\u{1F1E6}-\u{1F1FF}]/u, 'tanpa emoji bendera');
  }
});

test('Fase 6: .vscodeignore membuang screenshot / SVG / scripts tetapi icon.png ikut paket', () => {
  const ignore = readFileSync(join(root, '.vscodeignore'), 'utf8').split('\n');
  for (const p of ['images/screenshots/**', 'images/*.svg', 'scripts/**', 'docs/**', 'deployment/**']) assert.ok(ignore.includes(p), p);
  assert.ok(!ignore.some((l) => /^images\/(icon\.png|\*\*|\*\.png)$/.test(l)));
});
