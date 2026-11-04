// dijalankan di extension host VS Code: muat tiap out/test/src/*.itest.js lalu jalankan export `tests` satu per satu.
// shortcut: runner mini tanpa mocha (node:test belum bisa jalan in-process di Node milik VS Code 1.90); ganti bila butuh hook/filter
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

export type ITests = Record<string, () => Promise<void>>;

/** .httpme milik user di test-extension (Environment buatan sendiri) disimpan dulu: beberapa itest menghapus folder itu */
function protectUserData(): () => void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const dir = root && join(root, '.httpme');
  if (!dir || !existsSync(dir)) return () => undefined;
  const backup = join(mkdtempSync(join(tmpdir(), 'httpme-it-')), '.httpme');
  cpSync(dir, backup, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  console.log(`itest: ${dir} disimpan sementara di ${backup}`);
  return () => {
    rmSync(dir, { recursive: true, force: true });
    cpSync(backup, dir, { recursive: true });
    rmSync(join(backup, '..'), { recursive: true, force: true }); // salinan sementara tidak ditinggal di /tmp
    console.log(`itest: ${dir} dikembalikan`);
  };
}

export async function run(): Promise<void> {
  const restore = protectUserData();
  try {
    await runAll();
  } finally {
    restore();
  }
}

async function runAll(): Promise<void> {
  const dir = join(__dirname, '..');
  const failed: string[] = [];
  let passed = 0;
  // ITEST=scriptLinks,scriptsFlow: hanya file itest itu (debug cepat)
  const only = process.env.ITEST?.split(',').filter(Boolean);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.itest.js') && (!only || only.some((o) => x.startsWith(o)))).sort()) {
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
