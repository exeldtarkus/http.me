// Gambar README: render halaman webview (Dashboard, Environment, Export, Import preview, Request) di Chromium headless dengan data contoh
// (toko fiktif "Shop API", builder asli dari out/src) + icon dari images/icon.svg. Hasil: images/icon.png, images/screenshots/*.png
// run: npm run compile && node scripts/screenshots.js   (playwright-core: env PW, global npm, atau cache npx terbaru)
// Samarkan kata sensitif lewat env: MASK_WORDS="kata1,kata2" (data contoh sudah fiktif, tidak ada yang di-hardcode di sini).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = (f) => path.join(root, 'out', 'src', f);
const outDir = path.join(root, 'images', 'screenshots');
const { webviewPage } = require(out('webviewPage'));
const { buildCollectionTree, summarizeCollections, summarizeEnvironments, buildCookieTree } = require(out('dashboard'));
const { buildExport, previewText } = require(out('exportRun'));
const { parseRequest } = require(out('httpFile'));
const { responseView } = require(out('response'));

function findPlaywright() {
  if (process.env.PW) return process.env.PW;
  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  for (const d of [path.join(npmRoot, 'playwright-core'), path.join(npmRoot, 'playwright', 'node_modules', 'playwright-core')]) if (fs.existsSync(d)) return d;
  const npx = path.join(process.env.HOME, '.npm', '_npx');
  const found = fs.existsSync(npx) ? fs.readdirSync(npx).map((d) => path.join(npx, d, 'node_modules', 'playwright-core'))
    .filter((d) => fs.existsSync(d)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
  if (!found.length) throw new Error('playwright-core not found: set PW=<path> or run `npx playwright install chromium`');
  return found[0];
}

// VS Code Dark+ theme variables
const THEME = `:root{--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;--vscode-foreground:#cccccc;
--vscode-editor-font-family:'Consolas','DejaVu Sans Mono','Courier New',monospace;--vscode-editor-font-size:13px;
--vscode-font-family:'Segoe UI','DejaVu Sans',sans-serif;--vscode-panel-border:#3c3c3c;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#cccccc;
--vscode-input-border:#3c3c3c;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#1177bb;
--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ccc;--vscode-list-hoverBackground:#2a2d2e;
--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;--vscode-list-inactiveSelectionBackground:#37373d;
--vscode-editorWidget-background:#252526;--vscode-editorWidget-border:#454545;--vscode-menu-background:#252526;--vscode-menu-foreground:#ccc;
--vscode-sideBar-background:#252526;--vscode-dropdown-background:#3c3c3c;--vscode-dropdown-foreground:#ccc;--vscode-dropdown-border:#3c3c3c;
--vscode-focusBorder:#007fd4;--vscode-textLink-foreground:#3794ff;--vscode-errorForeground:#f48771;--vscode-editorWarning-foreground:#cca700;
--vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-red:#f14c4c;--vscode-charts-orange:#d18616;--vscode-charts-yellow:#cca700;
--vscode-charts-purple:#b180d7;--vscode-icon-foreground:#c5c5c5;--vscode-descriptionForeground:#9d9d9d;--vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#fff;
--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-editor-findMatchHighlightBackground:#ea5c0055;--vscode-tab-activeBackground:#1e1e1e;--vscode-tab-inactiveBackground:#2d2d2d;
--vscode-editorGroupHeader-tabsBackground:#252526;--vscode-textCodeBlock-background:#0a0a0a;--vscode-textBlockQuote-background:#7f7f7f1a;
--vscode-editorHoverWidget-background:#252526;--vscode-editorHoverWidget-border:#454545;--vscode-symbolIcon-variableForeground:#75beff;
--vscode-terminal-ansiGreen:#0dbc79;--vscode-terminal-ansiYellow:#e5e510;--vscode-terminal-ansiRed:#cd3131;--vscode-terminal-ansiBlue:#2472c8;
font-family:var(--vscode-font-family);font-size:13px}`;

const mask = (s) => (process.env.MASK_WORDS || '').split(',').filter(Boolean).reduce((t, w) => t.split(w).join('*'.repeat(w.length)), s);

/** halaman asli webview + stub acquireVsCodeApi: pesan webview -> host diteruskan ke window.__host (diisi per halaman) */
const html = (name) => mask(webviewPage(name, { cspSource: 'https://localhost', nonce: 'n' }))
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replace(/<script nonce="n">/g, '<script>')
  .replace('<style>', `<style>${THEME}`)
  .replace('<head>', `<head><script>${STUB} window.__host = (m) => window.__hostBridge(m);</script>`);
const STUB = `window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__host && window.__host(m), getState: () => undefined, setState: () => undefined });`;

// ---------- data contoh: Shop API (fiktif) ----------
const REQ = (title, method, url, extra = '') => `### ${title}\n${method} ${url}\n${extra}`;
const files = [
  ['Shop API/Auth/Login.http', REQ('Login', 'POST', '{{baseUrl}}/auth/login', 'Content-Type: application/json\n\n{"email":"{{email}}","password":"{{password}}"}\n')],
  ['Shop API/Auth/Refresh token.http', REQ('Refresh token', 'POST', '{{baseUrl}}/auth/refresh')],
  ['Shop API/Orders/List orders.http', REQ('List orders', 'GET', '{{baseUrl}}/orders?status=paid&page=1')],
  ['Shop API/Orders/Get order.http', REQ('Get order', 'GET', '{{baseUrl}}/orders/{{orderId}}')],
  ['Shop API/Orders/Create order.http', REQ('Create order', 'POST', '{{baseUrl}}/orders', 'Content-Type: application/json\n\n{"items":[{"sku":"TSH-001","qty":2}]}\n')],
  ['Shop API/Orders/Cancel order.http', REQ('Cancel order', 'DELETE', '{{baseUrl}}/orders/{{orderId}}')],
  ['Shop API/Products/List products.http', REQ('List products', 'GET', '{{baseUrl}}/products')],
  ['Shop API/Products/Update product.http', REQ('Update product', 'PUT', '{{baseUrl}}/products/{{productId}}', 'Content-Type: application/json\n\n{"price":125000}\n')],
  ['Shop API/Products/Upload image.http', REQ('Upload image', 'POST', '{{baseUrl}}/products/{{productId}}/image', 'Content-Type: multipart/form-data; boundary=----httpme\n\n------httpme\nContent-Disposition: form-data; name="file"; filename="shirt.png"\n\n< ./shirt.png\n------httpme--\n')],
  ['Shop API/Health.http', REQ('Health', 'GET', '{{baseUrl}}/health')],
  ['Shop API/_variables.json', JSON.stringify({ httpmeFormat: 1, variables: [{ key: 'baseUrl', value: 'https://api.shop.test' }] })],
].map(([p, text]) => ({ path: p, text }));
const httpFiles = files.filter((f) => f.path.endsWith('.http'));
const ENV_VARS = [{ key: 'baseUrl', value: 'https://api.shop.test' }, { key: 'email', value: 'demo@shop.test' }, { key: 'password', value: null, secret: true }, { key: 'orderId', value: null }, { key: 'productId', value: '42' }];
const envs = [{ name: 'dev', vars: ENV_VARS }, { name: 'uat', vars: ENV_VARS.map((v) => ({ ...v, value: v.key === 'baseUrl' ? 'https://uat.shop.test' : v.value })) }, { name: 'prod', vars: ENV_VARS.map((v) => ({ ...v, value: v.key === 'baseUrl' ? 'https://api.shop.example' : v.key === 'email' ? null : v.value })) }];
const cookieJars = [{ env: 'dev', cookies: [
  { name: 'session', value: 'f3a91c0d7b2e4a58', domain: 'api.shop.test', path: '/', secure: true, httpOnly: true, expires: Date.now() + 86400000 },
  { name: 'cart', value: '3 items', domain: 'api.shop.test', path: '/', secure: false, httpOnly: false, expires: undefined },
] }];
const dashboardData = () => {
  const sum = summarizeCollections(httpFiles);
  const env = summarizeEnvironments(envs, 'dev', { dev: [], uat: [], prod: [] });
  const tree = buildCookieTree(cookieJars, Date.now(), (v) => `${v.slice(0, 3)}…`);
  return { type: 'data', workspace: 'shop-workspace', collections: { tree: buildCollectionTree(httpFiles, []), requests: sum.requests, files: sum.files },
    environments: { ...env, list: env.environments.length, globals: 2 }, cookies: { total: 2, tree } };
};

(async () => {
  const { chromium } = require(findPlaywright());
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    // icon 128x128 dari SVG
    const ip = await browser.newPage({ viewport: { width: 128, height: 128 } });
    await ip.setContent(`<body style="margin:0;background:transparent">${fs.readFileSync(path.join(root, 'images', 'icon.svg'), 'utf8')}</body>`);
    await ip.screenshot({ path: path.join(root, 'images', 'icon.png'), omitBackground: true });
    console.log('wrote images/icon.png');
    await ip.close();

    const page = async (name, { w = 1280, h = 760 } = {}, host) => {
      const p = await browser.newPage({ viewport: { width: w, height: h } });
      p.on('pageerror', (e) => console.error(`[${name}] page error: ${e.message}`));
      await p.exposeFunction('__hostBridge', (m) => host?.(m, p));
      await p.setContent(html(name));
      await p.waitForTimeout(150);
      if (process.env.DEBUG_SHOTS) console.error(`[${name}] script ok: ${await p.evaluate(() => typeof window.__host)}, body: ${(await p.content()).length}`);
      return p;
    };
    const send = (p, m) => p.evaluate((x) => window.postMessage(x, '*'), m);
    const shot = async (p, name, clip) => {
      await p.waitForTimeout(250);
      await p.screenshot({ path: path.join(outDir, name), ...(clip ? { clip } : {}) });
      console.log(`wrote images/screenshots/${name}`);
      await p.close();
    };

    // 1. Dashboard: Collections (tree terbuka) dan Environments
    let p = await page('dashboard', { w: 1100, h: 640 }, (m, pg) => { if (m.type === 'ready') send(pg, dashboardData()); });
    await p.waitForSelector('.row');
    await p.click('button:has-text("Expand all")');
    await shot(p, 'dashboard.png');
    p = await page('dashboard', { w: 1100, h: 520 }, (m, pg) => { if (m.type === 'ready') send(pg, dashboardData()); });
    await p.click('.tab[data-tab="environments"]');
    await shot(p, 'dashboard-environments.png');

    // 2. Environment editor: NULL, secret, initial / current value
    p = await page('environment', { w: 1000, h: 520 }, (m, pg) => {
      if (m.type === 'ready') send(pg, { type: 'state', name: 'dev', globals: false, active: true, vars: ENV_VARS, current: { orderId: '1001' }, secretSet: { password: true }, dirty: false });
    });
    await shot(p, 'environment.png');

    // 3. Export dialog: pratinjau asli dari buildExport
    const exportFiles = files.map((f) => ({ path: f.path.replace('Shop API/', ''), content: f.text }));
    const items = exportFiles.filter((f) => f.path.endsWith('.http')).map((f) => { const r = parseRequest(f.content); return { path: f.path, method: r.method, title: r.title }; });
    p = await page('exportDialog', { w: 1280, h: 800 }, (m, pg) => {
      if (m.type === 'ready') send(pg, { type: 'state', name: 'Shop API', items, out: '/workspace/exports/Shop API.postman_collection.json' });
      if (m.type === 'preview') {
        const sel = new Set(m.selected);
        const inc = exportFiles.filter((f) => !f.path.endsWith('.http') || sel.has(f.path));
        const b = buildExport('Shop API', inc, { format: m.format, yaml: m.yaml, outFile: m.out || '/workspace/exports/x.json', translateScripts: true, envValues: [{ name: 'dev', values: new Map([['baseUrl', 'https://api.shop.test']]) }, { name: 'prod', values: new Map([['baseUrl', 'https://api.shop.example']]) }], history: [] });
        send(pg, { type: 'preview', seq: m.seq, text: previewText(b.out[0].content), requests: b.requests, skipped: b.skipped.length, files: b.out.length, warnings: b.warnings });
      }
    });
    await p.waitForTimeout(500);
    await shot(p, 'export.png');

    // 4. Import preview
    p = await page('importPreview', { w: 1000, h: 640 }, (m, pg) => {
      if (m.type === 'ready') {
        send(pg, { type: 'state', name: 'Shop API', dir: '/workspace', format: 'OpenAPI', items: items.map((i, k) => ({ path: `Shop API/${i.path}`, method: i.method, title: i.title, warnings: k === 4 ? ['Example body generated from schema'] : [], exists: k === 1 })) });
      }
    });
    await shot(p, 'import.png');

    // 5. Request + response
    const res = { status: 200, statusText: 'OK', headers: [['content-type', 'application/json'], ['x-request-id', 'a1b2c3']], size: 214, timeMs: 87, url: 'https://api.shop.test/orders?status=paid&page=1',
      body: Buffer.from(JSON.stringify({ page: 1, total: 2, data: [{ id: 1001, status: 'paid', total: 250000 }, { id: 1002, status: 'paid', total: 125000 }] })) };
    const view = { kind: 'response', ...responseView(res, 'GET') };
    const req = parseRequest(httpFiles[2].text);
    p = await page('panel', { w: 1100, h: 760 }, (m, pg) => {
      if (m.type === 'ready') send(pg, { type: 'state', req, view, blocks: [], active: 0, dirty: false });
    });
    await p.waitForTimeout(400);
    await shot(p, 'request.png');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
