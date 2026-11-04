// dijalankan di extension host VS Code: muat tiap out/test/src/*.itest.js lalu jalankan export `tests` satu per satu.
// shortcut: runner mini tanpa mocha (node:test belum bisa jalan in-process di Node milik VS Code 1.90); ganti bila butuh hook/filter
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export type ITests = Record<string, () => Promise<void>>;

export async function run(): Promise<void> {
  const dir = join(__dirname, '..');
  const failed: string[] = [];
  let passed = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.itest.js')).sort()) {
    const { tests } = require(join(dir, f)) as { tests: ITests };
    for (const [name, fn] of Object.entries(tests)) {
      try {
        await fn();
        passed++;
        console.log(`ok   ${f} › ${name}`);
      } catch (e) {
        failed.push(`${f} › ${name}`);
        console.error(`FAIL ${f} › ${name}\n${e instanceof Error ? e.stack : String(e)}`);
      }
    }
  }
  console.log(`itest: ${passed} passed, ${failed.length} failed`);
  if (failed.length) throw new Error(`${failed.length} itest failed: ${failed.join(', ')}`);
}
