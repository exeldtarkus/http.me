// UI test (VS Code sungguhan lewat CDP, butuh playwright-core): section Http.Me ditutup semua, VS Code dimulai ulang dengan
// keadaan itu, lalu dibuka satu per satu. Harapan: tidak pernah blank — ada "Loading…" / progress sampai data tampil, lalu ditutup.
//   PW=<path playwright-core> node test/ui/unfold.js        (atau: npm run test:ui)
const { spawn } = require('node:child_process'); const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const pwPath = process.env.PW || 'playwright-core';
const { chromium } = require(pwPath);
const root = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** matikan seluruh grup proses VS Code (anak-anak Electron ikut) dan tunggu sampai benar-benar mati: sisa proses membuat run berikutnya terhubung ke jendela lama */
async function stop(child) {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-child.pid, sig); } catch { return; } // grup sudah tidak ada
    for (let i = 0; i < 30; i++) { await sleep(100); try { process.kill(-child.pid, 0); } catch { return; } }
  }
}

const vscodeDir = fs.readdirSync(path.join(root, '.vscode-test')).filter((d) => d.startsWith('vscode-')).sort().pop();
if (!vscodeDir) throw new Error('VS Code belum diunduh: jalankan npm run test:it sekali');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'httpme-ui-'));
delete process.env.ELECTRON_RUN_AS_NODE;
const SECTIONS = ['Collections', 'Environments', 'Cookies']; // Open dibuka saat start (tidak bisa ditutup semua oleh VS Code)

async function launch(port) {
  const child = spawn(path.join(root, '.vscode-test', vscodeDir, 'code'), [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, `--extensionDevelopmentPath=${root}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox', path.join(root, 'test-extension')], { stdio: 'ignore', detached: true });
  let b; for (let i = 0; i < 60; i++) { try { b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await sleep(1000); } }
  if (!b) throw new Error('CDP tidak tersedia');
  let page; for (let i = 0; i < 60 && !page; i++) { page = b.contexts()[0].pages().find((p) => /workbench/.test(p.url())); await sleep(500); }
  await page.waitForSelector('.monaco-workbench'); await sleep(2500);
  return { child, b, page };
}
const hdr = (page, t) => page.locator('.pane-header', { hasText: new RegExp(`^\\s*${t}`, 'i') }).first();
const isOpen = async (page, t) => (await hdr(page, t).getAttribute('aria-expanded')) === 'true';
const SAMPLER = `(() => {
  window.__s = []; window.__title = '~'; window.__run = true;
  const f = () => { if (!window.__run) return;
    const h = [...document.querySelectorAll('.pane-header')].find((x) => x.textContent.trim().toLowerCase().startsWith(window.__title));
    if (h) { const p = h.closest('.pane'); const body = p.querySelector('.pane-body');
      window.__s.push({ t: performance.now(), open: h.getAttribute('aria-expanded') === 'true', h: body?.getBoundingClientRect().height ?? 0,
        rows: [...p.querySelectorAll('.monaco-list-row')].filter((r) => r.offsetHeight > 0).length,
        welcome: [...p.querySelectorAll('.welcome-view-content')].filter((e) => e.offsetHeight > 0).map((e) => e.textContent.trim()).join('|'),
        msg: /^Loading…/.test(body?.innerText ?? ''), prog: !!p.querySelector('.monaco-progress-container.active') }); }
    requestAnimationFrame(f); };
  requestAnimationFrame(f); })()`;

(async () => {
  const s = await launch(9400 + Math.floor(Math.random() * 500));
  await s.page.click('[aria-label="Http.Me"], .activitybar [aria-label*="Http" i]'); await s.page.waitForSelector('.pane-header'); await sleep(1500);
  for (const t of SECTIONS) if (await isOpen(s.page, t)) { await hdr(s.page, t).click(); await sleep(300); }
  console.log('FASE 1: ditutup', JSON.stringify(await Promise.all(SECTIONS.map((t) => isOpen(s.page, t)))));
  // Reload Window: extension host & tampilan dibuat ulang dengan section tetap tertutup (seperti membuka VS Code lagi)
  await sleep(1500);
  await s.page.keyboard.press('F1'); await sleep(500); await s.page.keyboard.type('Developer: Reload Window'); await sleep(700); await s.page.keyboard.press('Enter');
  await sleep(4000);
  await s.page.waitForSelector('.monaco-workbench', { timeout: 60000 }); await s.page.waitForSelector('.pane-header', { timeout: 60000 }); await sleep(2500);
  const start = await Promise.all(SECTIONS.map((t) => isOpen(s.page, t)));
  console.log('FASE 2: awal', JSON.stringify(start));
  if (start.some(Boolean)) throw new Error('keadaan tertutup tidak dipulihkan VS Code');
  await s.page.evaluate(SAMPLER);
  let bad = 0;
  for (const t of SECTIONS) {
    await s.page.evaluate((n) => { window.__s.length = 0; window.__title = n.toLowerCase(); }, t);
    await hdr(s.page, t).click(); await sleep(3500);
    const f = (await s.page.evaluate(() => window.__s)).filter((x) => x.open);
    const first = f.findIndex((x) => x.rows > 0);
    const blank = f.filter((x) => x.h > 20 && x.rows === 0 && !x.welcome && !x.msg && !x.prog).length;
    const lastMsg = [...f].reverse().find((x) => x.msg);
    const last = f[f.length - 1];
    const ok = first >= 0 && blank <= 2 && f[first].t - f[0].t < 500 && !last.msg && last.rows > 0;
    console.log(ok ? 'ok  ' : 'FAIL', t.padEnd(13), `baris tampil @${first >= 0 ? Math.round(f[first].t - f[0].t) : '-'}ms, frame blank=${blank}, "Loading…" sampai @${lastMsg ? Math.round(lastMsg.t - f[0].t) : '-'}ms, akhir: baris=${last.rows} loading=${last.msg}`);
    if (!ok) bad++;
  }
  console.log(bad ? `FAIL: ${bad} section blank / loading tidak tertutup` : 'PASS: tidak ada blank, loading tertutup setelah data tampil');
  await s.b.close().catch(() => undefined); await stop(s.child); process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error('ERR', e.message); process.exitCode = 2; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 1500));
