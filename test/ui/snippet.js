// UI test (VS Code sungguhan lewat CDP, butuh playwright-core): panel Code snippet — tombol & Ctrl+Alt+C, bahasa, update langsung saat
// request diubah, Copy (ikon centang), tutup saat klik di luar.   PW=<path playwright-core> node test/ui/snippet.js   (atau npm run test:ui)
const { spawn } = require('node:child_process'); const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const { chromium } = require(process.env.PW || 'playwright-core');
const root = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vscodeDir = fs.readdirSync(path.join(root, '.vscode-test')).filter((d) => d.startsWith('vscode-')).sort().pop();
delete process.env.ELECTRON_RUN_AS_NODE;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'httpme-ui-'));
const dir = path.join(root, 'test-extension', 'zz-ui-snippet'); const file = path.join(dir, 'snippet-ui.http');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, 'POST https://api.example.test/items?x=1\nContent-Type: application/json\n\n{\n  "name": "demo",\n  "n": [1, 2]\n}\n');
const results = []; const check = (name, ok, detail = '') => { results.push(ok); console.log(ok ? 'ok  ' : 'FAIL', name, detail); };

(async () => {
  const child = spawn(path.join(root, '.vscode-test', vscodeDir, 'code'), ['--remote-debugging-port=9351', `--user-data-dir=${userData}`, `--extensionDevelopmentPath=${root}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox', path.join(root, 'test-extension')], { stdio: 'ignore' });
  let b; for (let i = 0; i < 60; i++) { try { b = await chromium.connectOverCDP('http://127.0.0.1:9351'); break; } catch { await sleep(1000); } }
  let page; for (let i = 0; i < 60 && !page; i++) { page = b.contexts()[0].pages().find((p) => /workbench/.test(p.url())); await sleep(500); }
  await page.waitForSelector('.monaco-workbench'); await sleep(3000);
  const palette = async (text) => { await page.keyboard.press('F1'); await sleep(500); await page.keyboard.type(text); await sleep(900); await page.keyboard.press('Enter'); await sleep(1500); };
  try {
    // buka file, lalu di panel http.me
    const openFile = async () => { await page.keyboard.press('Control+P'); await sleep(600); await page.keyboard.type('snippet-ui.http'); await sleep(1200); await page.keyboard.press('Enter'); await sleep(2500); };
    await openFile();
    await palette("http.me: What's New"); // aktifkan extension secara deterministik (command pertama = aktivasi)
    await sleep(4000);
    const closeWhatsNew = async () => { const t = page.locator('.tab', { hasText: 'What' }).first(); for (let i = 0; i < 3 && await t.count(); i++) { await t.hover(); await t.locator('.action-label').click().catch(() => undefined); await sleep(700); } };
    await closeWhatsNew();
    await page.locator('.tab', { hasText: 'snippet-ui.http' }).first().click(); await sleep(1000);
    await palette('http.me: Open in http.me Panel');
    await sleep(3000);
    await closeWhatsNew();
    await page.locator('.tab', { hasText: 'snippet-ui.http' }).last().click(); await sleep(1500); // tab ke-2 = editor panel http.me
    // webview = iframe di dalam iframe; cari frame yang memuat #codeBtn
    let ui; for (let i = 0; i < 40 && !ui; i++) { for (const f of page.frames()) { if (await f.$('#codeBtn').catch(() => null)) { ui = f; break; } } await sleep(500); }
    check('panel request terbuka', !!ui);
    const panelHidden = () => ui.$eval('#codePanel', (e) => e.hidden);
    const text = () => ui.$eval('#cpText', (e) => e.textContent);
    const until = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => false); if (v) return v; if (Date.now() > end) return false; await sleep(100); } };

    check('panel snippet tertutup di awal', await panelHidden());
    await ui.click('#codeBtn');
    check('klik </> Code membuka panel', !(await panelHidden()));
    check('cURL tampil dengan body JSON satu baris', !!(await until(async () => /curl -X POST 'https:\/\/api\.example\.test\/items\?x=1'/.test(await text()) && /--data-raw '\{"name":"demo","n":\[1,2\]\}'/.test(await text()))), JSON.stringify((await text()).slice(0, 90)));

    await ui.selectOption('#cpLang', 'powershell');
    check('dropdown PowerShell mengubah snippet', !!(await until(async () => /^Invoke-WebRequest -UseBasicParsing -Uri "https:\/\/api\.example\.test/.test(await text()))));
    await ui.selectOption('#cpLang', 'cmd');
    check('dropdown cURL (cmd) mengubah snippet', !!(await until(async () => /\^"https:\/\/api\.example\.test/.test(await text()))));
    await ui.selectOption('#cpLang', 'curl');

    // request diubah di panel -> snippet ikut langsung (tanpa buka ulang)
    await ui.fill('#url', 'https://api.example.test/changed?y=2');
    check('ubah URL di panel -> snippet langsung ikut', !!(await until(async () => (await text()).includes('https://api.example.test/changed?y=2'))), JSON.stringify((await text()).slice(0, 70)));

    // opsi
    await ui.check('#cpOpts input[data-o="longForm"]');
    check('opsi Long-form -> --request / --header', !!(await until(async () => /--request POST/.test(await text()) && /--header /.test(await text()))));
    await ui.uncheck('#cpOpts input[data-o="longForm"]');
    await ui.uncheck('#cpOpts input[data-o="multiLine"]');
    check('opsi Multi-line off -> satu baris', !!(await until(async () => !(await text()).includes('\n'))));
    await ui.check('#cpOpts input[data-o="multiLine"]');

    // Copy: ikon berubah jadi centang setelah host menyalin
    await ui.click('#cpCopy');
    check('Copy menampilkan centang', !!(await until(() => ui.$eval('#cpCopy', (e) => e.classList.contains('done')))));

    // klik di luar panel menutup; Ctrl+Alt+C membuka lagi; Escape menutup
    await ui.click('#url');
    check('klik di luar menutup panel', !!(await until(panelHidden)));
    await ui.press('#url', 'Control+Alt+c');
    check('Ctrl+Alt+C membuka panel', !!(await until(async () => !(await panelHidden()))));
    await ui.press('#cpText', 'Escape');
    check('Escape menutup panel', !!(await until(panelHidden)));
  } finally {
    await b.close(); child.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true });
  }
  const bad = results.filter((x) => !x).length;
  console.log(bad ? `FAIL: ${bad} cek gagal` : 'PASS: panel Code snippet');
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error('ERR', e.message); fs.rmSync(dir, { recursive: true, force: true }); process.exitCode = 2; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 1500));
