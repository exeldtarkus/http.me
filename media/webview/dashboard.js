// Dashboard 3 tab (Collections / Environments / Cookies): tree klik + drag & drop + menu klik kanan, semua aksi sidebar (webview, JS vanilla).
// Fungsi murni diekspor ke Node untuk unit test.
(function () {
  const ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  /** {GET: 3, ...} → segmen bar [{method, n, pct}] urut tetap; method lain digabung "other" */
  function segments(methods) {
    const total = Object.values(methods).reduce((a, b) => a + b, 0);
    const out = ORDER.filter((m) => methods[m]).map((m) => ({ method: m, n: methods[m] }));
    const rest = Object.entries(methods).filter(([m]) => !ORDER.includes(m)).reduce((a, [, n]) => a + n, 0);
    if (rest) out.push({ method: 'other', n: rest });
    return out.map((s) => ({ ...s, pct: total ? (s.n / total) * 100 : 0 }));
  }
  const parentOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
  /** tree + folder terbuka + filter → baris tampil [{node, depth}]; filter membuka semua folder induk yang cocok */
  function flatten(tree, open, q) {
    const t = q.trim().toLowerCase();
    const hit = (n) => !t || [n.name, n.title, n.method].some((x) => (x || '').toLowerCase().includes(t));
    const out = [];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        if (n.type === 'file') { if (hit(n)) out.push({ node: n, depth }); continue; }
        const sub = [];
        const before = out.length;
        out.push({ node: n, depth });
        if (t || open.has(n.path)) walk(n.children || [], depth + 1);
        if (t && out.length === before + 1 && !hit(n)) out.pop();
        void sub;
      }
    };
    walk(tree, 0);
    return out;
  }
  /** boleh drop `from` (path relatif) ke folder `to` ('' = root): bukan ke dirinya / turunannya / folder asalnya */
  function canDrop(from, to) {
    return from.every((f) => to !== f && !to.startsWith(`${f}/`) && parentOf(f) !== to);
  }
  const api = { segments, flatten, canDrop, parentOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = { tab: saved.tab || 'collections', open: new Set(saved.open || []), copen: new Set(saved.copen || []), filter: saved.filter || '' };
  let data = null;
  let sel = new Set();
  let dragging = null;
  const persist = () => vscode.setState({ tab: ui.tab, open: [...ui.open], copen: [...ui.copen], filter: ui.filter });
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, children) => { const e = Object.assign(document.createElement(tag), props || {}); for (const c of children || []) if (c) e.append(c); return e; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const act = (id, args) => vscode.postMessage({ type: 'act', id, args: args || {} });
  const SVG = 'http://www.w3.org/2000/svg';
  const icon = (kind) => {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('class', `ico ${kind}`); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', kind === 'folder' ? 'M1.5 3A1.5 1.5 0 0 1 3 1.5h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 4.5v7A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5z' : 'M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5zM8.5 2v3h3');
    if (kind !== 'folder') { path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); }
    svg.append(path);
    return svg;
  };

  // ---------- menu klik kanan ----------
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function showMenu(items, x, y) {
    closeMenu();
    const m = el('div', { className: 'menu', role: 'menu' }, items.map((i) => (i === '-' ? el('hr') : el('button', { type: 'button', role: 'menuitem', textContent: i.label, className: i.danger ? 'danger' : '', onclick: () => { closeMenu(); act(i.id, i.args); } }))));
    document.body.append(m);
    m.style.left = `${Math.min(x, window.innerWidth - m.offsetWidth - 6)}px`;
    m.style.top = `${Math.min(y, window.innerHeight - m.offsetHeight - 6)}px`;
    menuEl = m;
    m.querySelector('button')?.focus();
  }
  document.addEventListener('click', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('blur', closeMenu);
  const dots = (items) => el('button', { type: 'button', className: 'ibtn', textContent: '⋯', title: 'More actions', onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); showMenu(items, r.left, r.bottom); } });
  const small = (text, onclick, title) => el('button', { type: 'button', className: 'ibtn', textContent: text, title: title || text, onclick: (e) => { e.stopPropagation(); onclick(e); } });

  // ---------- Collections ----------
  const fileMenu = (n) => [
    { label: 'Open', id: 'file.open', args: { path: n.path } }, { label: 'Open as Text', id: 'file.openAsText', args: { path: n.path } }, '-',
    { label: 'Duplicate', id: 'file.duplicate', args: { path: n.path } }, { label: 'Rename', id: 'file.rename', args: { path: n.path } }, { label: 'Delete', id: 'file.delete', args: { paths: [n.path] }, danger: true }, '-',
    ...(n.method ? [{ label: 'Copy as cURL', id: 'file.copyAsCurl', args: { path: n.path } }, { label: 'Copy as cURL with Cookies', id: 'file.copyAsCurlWithCookies', args: { path: n.path } },
      { label: 'Copy as cURL (cmd)', id: 'file.copyAsCurlCmd', args: { path: n.path } }, { label: 'Copy as cURL (cmd) with Cookies', id: 'file.copyAsCurlCmdWithCookies', args: { path: n.path } },
      { label: 'Copy as PowerShell', id: 'file.copyAsPowerShell', args: { path: n.path } }, { label: 'Copy as PowerShell with Cookies', id: 'file.copyAsPowerShellWithCookies', args: { path: n.path } }, '-',
      { label: 'Set as Login Request', id: 'file.setLoginRequest', args: { path: n.path } }] : []),
    { label: 'Reveal in Explorer', id: 'file.reveal', args: { path: n.path } }];
  const folderMenu = (n) => [
    { label: 'New Request', id: 'folder.newRequest', args: { path: n.path } }, { label: 'New Folder', id: 'folder.newFolder', args: { path: n.path } }, '-',
    { label: 'Rename', id: 'folder.rename', args: { path: n.path } }, { label: 'Delete', id: 'file.delete', args: { paths: [n.path] }, danger: true }, '-',
    { label: 'Re-import from Source', id: 'folder.reimport', args: { path: n.path } }, { label: 'Reveal in Explorer', id: 'file.reveal', args: { path: n.path } }];
  const rootMenu = () => [{ label: 'New Request', id: 'coll.newRequest' }, { label: 'New Collection', id: 'coll.newCollection' }, { label: 'New Folder', id: 'coll.newFolder' }, '-', { label: 'Import…', id: 'coll.import' }];

  function collRow(r, order) {
    const n = r.node;
    const isFolder = n.type === 'folder';
    const row = el('div', { className: `row${sel.has(n.path) ? ' sel' : ''}`, draggable: true, role: 'treeitem', tabIndex: -1, title: n.path });
    row.dataset.path = n.path;
    row.style.paddingLeft = `${6 + r.depth * 16}px`;
    const chev = el('span', { className: `chev${isFolder && (ui.open.has(n.path) || ui.filter) ? ' open' : ''}`, textContent: isFolder ? '›' : '' });
    row.append(chev, icon(isFolder ? 'folder' : 'file'));
    const label = el('span', { className: 'grow' }, [
      !isFolder && n.method ? el('span', { className: `method ${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(n.method) ? n.method : 'other'}`, textContent: n.method }) : null,
      el('span', { className: `name${isFolder ? ' folder' : ''}`, textContent: n.name }),
      !isFolder && n.title && n.title !== n.name.replace(/\.http$/i, '') ? el('span', { className: 'muted name', textContent: n.title }) : null,
      !isFolder && n.requests > 1 ? el('span', { className: 'pill', textContent: `${n.requests} requests` }) : null,
    ]);
    row.append(label);
    if (isFolder) {
      row.append(el('span', { className: 'pill', textContent: plural(n.count, 'request') }),
        el('span', { className: 'acts' }, [small('+ Request', () => act('folder.newRequest', { path: n.path }), 'New Request'), small('+ Folder', () => act('folder.newFolder', { path: n.path }), 'New Folder'), dots(folderMenu(n))]));
    } else row.append(el('span', { className: 'acts' }, [small('Open', () => act('file.open', { path: n.path })), dots(fileMenu(n))]));

    row.onclick = (e) => {
      if (isFolder && (e.target === chev)) { toggle(n.path); return; }
      if (e.ctrlKey || e.metaKey) { if (sel.has(n.path)) sel.delete(n.path); else sel.add(n.path); }
      else if (e.shiftKey && order.last) {
        const a = order.paths.indexOf(order.last), b = order.paths.indexOf(n.path);
        sel = new Set(order.paths.slice(Math.min(a, b), Math.max(a, b) + 1));
      } else sel = new Set([n.path]);
      order.last = n.path;
      render();
    };
    row.ondblclick = () => { if (isFolder) toggle(n.path); else act('file.open', { path: n.path }); };
    row.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!sel.has(n.path)) { sel = new Set([n.path]); render(); }
      showMenu(sel.size > 1 ? [{ label: `Delete ${sel.size} items`, id: 'file.delete', args: { paths: [...sel] }, danger: true }] : isFolder ? folderMenu(n) : fileMenu(n), e.clientX, e.clientY);
    };
    row.ondragstart = (e) => {
      if (!sel.has(n.path)) sel = new Set([n.path]);
      dragging = [...sel];
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragging.join('\n'));
      row.classList.add('dragging');
    };
    row.ondragend = () => { dragging = null; render(); };
    if (isFolder) {
      row.ondragover = (e) => { if (dragging && canDrop(dragging, n.path)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drop'); } };
      row.ondragleave = () => row.classList.remove('drop');
      row.ondrop = (e) => dropOn(e, n.path);
    }
    return row;
  }
  function toggle(path) { if (ui.open.has(path)) ui.open.delete(path); else ui.open.add(path); persist(); render(); }
  function dropOn(e, to) {
    e.preventDefault(); e.stopPropagation();
    if (dragging && canDrop(dragging, to)) act('move', { from: dragging, to });
    else if (!dragging && e.dataTransfer.files.length) readDropped(e.dataTransfer.files);
    dragging = null;
  }
  /** file dari luar VS Code (spec / collection): isi dibaca di webview lalu dikirim sebagai teks ke Import */
  function readDropped(files) {
    const list = [...files].filter((f) => /\.(json|ya?ml)$/i.test(f.name));
    if (!list.length) return vscode.postMessage({ type: 'note', text: 'Drop .json, .yaml or .yml files to import them.' });
    Promise.all(list.map((f) => f.text().then((text) => ({ name: f.name, text })))).then((items) => act('coll.importText', { items }));
  }
  function allFolders(nodes, out) { for (const n of nodes) if (n.type === 'folder') { out.push(n.path); allFolders(n.children || [], out); } return out; }

  function renderCollections(box) {
    const c = data.collections;
    const filter = el('input', { type: 'search', placeholder: 'Filter by name, method or title', value: ui.filter, 'aria-label': 'Filter', oninput: (e) => { ui.filter = e.target.value; persist(); renderList(); } });
    box.append(el('div', { className: 'toolbar' }, [
      el('button', { type: 'button', className: 'btn pri', textContent: 'New Request', onclick: () => act('coll.newRequest') }),
      el('button', { type: 'button', className: 'btn ghost', textContent: 'New Collection', onclick: () => act('coll.newCollection') }),
      el('button', { type: 'button', className: 'btn ghost', textContent: 'New Folder', onclick: () => act('coll.newFolder') }),
      el('button', { type: 'button', className: 'btn ghost', textContent: 'Import…', onclick: () => act('coll.import') }),
      filter,
      el('button', { type: 'button', className: 'btn ghost', textContent: 'Expand all', onclick: () => { ui.open = new Set(allFolders(c.tree, [])); persist(); render(); } }),
      el('button', { type: 'button', className: 'btn ghost', textContent: 'Collapse all', onclick: () => { ui.open.clear(); persist(); render(); } }),
    ]));
    box.append(el('p', { className: 'summary', textContent: `${plural(c.requests, 'request')} in ${plural(c.files, 'file')}` }));
    const list = el('div', { className: 'list', role: 'tree', tabIndex: 0, id: 'tree' });
    box.append(list, el('p', { className: 'hint', textContent: 'Double-click opens a request · drag items onto folders to move them · drop a Postman / OpenAPI file here to import · right-click for more · Delete, F2 and Enter work on the selection.' }));
    function renderList() {
      const rows = flatten(c.tree, ui.open, ui.filter);
      const order = { paths: rows.map((r) => r.node.path), last: null };
      list.replaceChildren(...(rows.length ? rows.map((r) => collRow(r, order)) : [el('div', { className: 'empty', textContent: ui.filter ? 'Nothing matches the filter.' : 'No .http requests yet. Create a request or import a Postman / OpenAPI file.' })]));
      list.onkeydown = (e) => {
        const one = sel.size === 1 ? rows.find((r) => r.node.path === [...sel][0]) : undefined;
        if (e.key === 'Delete' && sel.size) { e.preventDefault(); act('file.delete', { paths: [...sel] }); }
        else if (e.key === 'F2' && one) { e.preventDefault(); act(one.node.type === 'folder' ? 'folder.rename' : 'file.rename', { path: one.node.path }); }
        else if (e.key === 'Enter' && one) { if (one.node.type === 'folder') toggle(one.node.path); else act('file.open', { path: one.node.path }); }
        else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
          e.preventDefault();
          const i = one ? order.paths.indexOf(one.node.path) : -1;
          const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
          sel = new Set([next.node.path]); renderList();
        } else if (e.key === 'ArrowRight' && one?.node.type === 'folder' && !ui.open.has(one.node.path)) toggle(one.node.path);
        else if (e.key === 'ArrowLeft' && one?.node.type === 'folder' && ui.open.has(one.node.path)) toggle(one.node.path);
      };
    }
    renderList();
    list.oncontextmenu = (e) => { e.preventDefault(); sel = new Set(); showMenu(rootMenu(), e.clientX, e.clientY); };
    list.ondragover = (e) => { if ((dragging && canDrop(dragging, '')) || (!dragging && [...e.dataTransfer.types].includes('Files'))) { e.preventDefault(); list.classList.add('drop-root'); } };
    list.ondragleave = (e) => { if (e.target === list) list.classList.remove('drop-root'); };
    list.ondrop = (e) => { list.classList.remove('drop-root'); dropOn(e, ''); };
  }

  // ---------- Environments ----------
  const envMenu = (e) => [{ label: e.active ? 'Active' : 'Set Active', id: 'env.setActive', args: { name: e.name } }, { label: 'Open', id: 'env.open', args: { name: e.name } }, { label: 'Open as Text', id: 'env.openAsText', args: { name: e.name } }, '-',
    { label: 'Rename', id: 'env.rename', args: { name: e.name } }, { label: 'Duplicate', id: 'env.duplicate', args: { name: e.name } }, { label: 'Delete', id: 'env.delete', args: { name: e.name }, danger: true }, '-', { label: 'Reveal in Explorer', id: 'env.reveal', args: { name: e.name } }];
  function renderEnvironments(box) {
    const d = data.environments;
    box.append(el('div', { className: 'toolbar' }, [
      el('button', { type: 'button', className: 'btn pri', textContent: 'New Environment', onclick: () => act('env.new') }),
      el('button', { type: 'button', className: 'btn ghost', textContent: 'Import Postman Environment…', onclick: () => act('env.import') }),
      el('button', { type: 'button', className: 'btn ghost', textContent: 'All Environments', onclick: () => act('env.compare') }),
      el('button', { type: 'button', className: 'btn ghost', textContent: 'Sync Keys', onclick: () => act('env.sync') }),
      el('button', { type: 'button', className: 'btn ghost', textContent: 'Add Variable to All…', onclick: () => act('env.addVariable') }),
    ]));
    box.append(el('p', { className: 'summary', textContent: `Active: ${d.active || 'none'} · ${d.totalNulls ? `${d.totalNulls} NULL values to fill` : 'no NULL values'}` }));
    const rows = [
      el('div', { className: 'row', tabIndex: 0, ondblclick: () => act('env.openGlobals'), oncontextmenu: (e) => { e.preventDefault(); showMenu([{ label: 'Open', id: 'env.openGlobals' }, { label: 'Open as Text', id: 'env.openGlobalsText' }], e.clientX, e.clientY); } }, [
        el('span', { className: 'dot' }), el('span', { className: 'grow' }, [el('span', { className: 'name folder', textContent: 'Globals' }), el('span', { className: 'muted', textContent: `every Environment · ${plural(d.globals, 'variable')}` })]),
        el('span', { className: 'acts' }, [small('Open', () => act('env.openGlobals')), small('Open as Text', () => act('env.openGlobalsText'))])]),
      el('div', { className: 'row', tabIndex: 0, onclick: () => act('env.setActive', { name: undefined }) }, [
        el('span', { className: `dot${d.active ? '' : ' on'}` }), el('span', { className: 'grow' }, [el('span', { className: 'name', textContent: 'No Environment' })]),
        d.active ? el('span', { className: 'acts' }, [small('Set Active', () => act('env.setActive', { name: undefined }))]) : el('span', { className: 'pill', textContent: 'active' })]),
      ...d.environments.map((e) => {
        const row = el('div', { className: `row${sel.has(`env:${e.name}`) ? ' sel' : ''}`, tabIndex: 0, title: e.name }, [
          el('span', { className: `dot${e.active ? ' on' : ''}`, title: e.active ? 'Active' : 'Click to set active', onclick: (ev) => { ev.stopPropagation(); act('env.setActive', { name: e.name }); } }),
          el('span', { className: 'grow' }, [el('span', { className: 'name folder', textContent: e.name }), el('span', { className: 'muted', textContent: `${plural(e.variables, 'variable')}${e.secrets ? ` · ${e.secrets} secret` : ''}` })]),
          e.nulls ? el('span', { className: 'pill warn', textContent: `${e.nulls} NULL` }) : el('span', { className: 'pill ok', textContent: 'complete' }),
          e.active ? el('span', { className: 'pill', textContent: 'active' }) : null,
          el('span', { className: 'acts' }, [e.active ? null : small('Set Active', () => act('env.setActive', { name: e.name })), small('Open', () => act('env.open', { name: e.name })), dots(envMenu(e))])]);
        row.onclick = () => { sel = new Set([`env:${e.name}`]); render(); };
        row.ondblclick = () => act('env.open', { name: e.name });
        row.oncontextmenu = (ev) => { ev.preventDefault(); sel = new Set([`env:${e.name}`]); showMenu(envMenu(e), ev.clientX, ev.clientY); };
        row.onkeydown = (ev) => { if (ev.key === 'Delete') act('env.delete', { name: e.name }); else if (ev.key === 'F2') act('env.rename', { name: e.name }); else if (ev.key === 'Enter') act('env.open', { name: e.name }); };
        return row;
      }),
    ];
    box.append(el('div', { className: 'list' }, d.environments.length ? rows : [...rows, el('div', { className: 'empty', textContent: 'No Environments yet. Create one to use variables in requests.' })]),
      el('p', { className: 'hint', textContent: 'Click the dot to set the active Environment · double-click opens the editor · right-click for rename, duplicate and delete.' }));
  }

  // ---------- Cookies ----------
  function renderCookies(box) {
    const d = data.cookies;
    box.append(el('div', { className: 'toolbar' }, [
      el('button', { type: 'button', className: 'btn pri', textContent: 'Add Cookie…', onclick: () => act('cookie.add', {}) }),
      el('button', { type: 'button', className: 'btn ghost', textContent: 'Paste Cookies from Browser', onclick: () => act('cookie.paste', {}) }),
      el('button', { type: 'button', className: 'btn ghost', textContent: 'Delete All Cookies', onclick: () => act('cookie.clearAll') }),
    ]));
    box.append(el('p', { className: 'summary', textContent: `${plural(d.total, 'cookie')} saved on this computer (values are hidden)` }));
    const rows = [];
    for (const e of d.tree) {
      const ek = `e:${e.env}`;
      const eopen = !ui.copen.has(ek);
      const toggleC = (k) => () => { if (ui.copen.has(k)) ui.copen.delete(k); else ui.copen.add(k); persist(); render(); }; // copen = key yang ditutup
      rows.push(el('div', { className: 'row', tabIndex: 0, onclick: toggleC(ek), oncontextmenu: (ev) => { ev.preventDefault(); showMenu([{ label: 'Add Cookie…', id: 'cookie.add', args: { env: e.env } }, { label: 'Paste Cookies from Browser', id: 'cookie.paste', args: { env: e.env } }, '-', { label: 'Delete All Cookies', id: 'cookie.clearEnv', args: { env: e.env }, danger: true }], ev.clientX, ev.clientY); } }, [
        el('span', { className: `chev${eopen ? ' open' : ''}`, textContent: '›' }), el('span', { className: 'grow' }, [el('span', { className: 'name folder', textContent: e.label })]), el('span', { className: 'pill', textContent: plural(e.cookies, 'cookie') }),
        el('span', { className: 'acts' }, [small('Paste', () => act('cookie.paste', { env: e.env }), 'Paste Cookies from Browser'), small('Delete all', () => act('cookie.clearEnv', { env: e.env }))])]));
      if (!eopen) continue;
      if (!e.domains.length) rows.push(el('div', { className: 'row muted', style: 'padding-left:28px', textContent: 'No cookies' }));
      for (const dm of e.domains) {
        const dk = `d:${e.env}:${dm.domain}`;
        const dopen = !ui.copen.has(dk);
        const dmenu = [{ label: 'Add Cookie…', id: 'cookie.add', args: { env: e.env, domain: dm.domain } }, { label: 'Paste Cookies from Browser', id: 'cookie.paste', args: { env: e.env, domain: dm.domain } }, '-', { label: 'Delete Cookies of Domain', id: 'cookie.deleteDomain', args: { env: e.env, domain: dm.domain }, danger: true }];
        rows.push(el('div', { className: 'row', tabIndex: 0, style: 'padding-left:22px', onclick: toggleC(dk), oncontextmenu: (ev) => { ev.preventDefault(); showMenu(dmenu, ev.clientX, ev.clientY); } }, [
          el('span', { className: `chev${dopen ? ' open' : ''}`, textContent: '›' }), el('span', { className: 'grow' }, [el('span', { className: 'name', textContent: dm.domain })]), el('span', { className: 'pill', textContent: plural(dm.cookies.length, 'cookie') }),
          el('span', { className: 'acts' }, [small('+ Cookie', () => act('cookie.add', { env: e.env, domain: dm.domain }), 'Add Cookie'), dots(dmenu)])]));
        if (!dopen) continue;
        for (const c of dm.cookies) {
          const args = { env: e.env, domain: dm.domain, name: c.name, path: c.path };
          const cmenu = [{ label: 'Edit Value…', id: 'cookie.edit', args }, { label: 'Delete', id: 'cookie.delete', args, danger: true }];
          const row = el('div', { className: 'row', tabIndex: 0, style: 'padding-left:50px', title: `${c.name} · ${c.path}`, ondblclick: () => act('cookie.edit', args), oncontextmenu: (ev) => { ev.preventDefault(); showMenu(cmenu, ev.clientX, ev.clientY); } }, [
            el('span', { className: 'grow' }, [el('span', { className: 'name', textContent: c.name }), el('span', { className: 'muted name', textContent: c.value }), el('span', { className: 'muted', textContent: c.path })]),
            c.secure ? el('span', { className: 'pill', textContent: 'secure' }) : null, c.httpOnly ? el('span', { className: 'pill', textContent: 'httpOnly' }) : null, c.expired ? el('span', { className: 'pill err', textContent: 'expired' }) : null,
            el('span', { className: 'acts' }, [small('Edit', () => act('cookie.edit', args), 'Edit Value'), small('Delete', () => act('cookie.delete', args))])]);
          row.onkeydown = (ev) => { if (ev.key === 'Delete') act('cookie.delete', args); else if (ev.key === 'Enter') act('cookie.edit', args); };
          rows.push(row);
        }
      }
    }
    box.append(el('div', { className: 'list' }, rows.length ? rows : [el('div', { className: 'empty', textContent: 'No saved cookies. They appear after a request receives Set-Cookie.' })]),
      el('p', { className: 'hint', textContent: 'Double-click a cookie to edit its value · right-click for more · every delete asks for confirmation.' }));
  }

  function render() {
    if (!data) return;
    closeMenu();
    $('ws').textContent = data.workspace;
    $('c-collections').textContent = String(data.collections.requests);
    $('c-environments').textContent = data.environments.totalNulls ? `${data.environments.list} · ${data.environments.totalNulls} NULL` : String(data.environments.list);
    $('c-environments').className = `count${data.environments.totalNulls ? ' warn' : ''}`;
    $('c-cookies').textContent = String(data.cookies.total);
    for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === ui.tab));
    const box = $('panel');
    const scroll = window.scrollY;
    box.replaceChildren();
    box.setAttribute('aria-labelledby', `tab-${ui.tab}`);
    if (ui.tab === 'collections') renderCollections(box); else if (ui.tab === 'environments') renderEnvironments(box); else renderCookies(box);
    window.scrollTo(0, scroll);
  }
  for (const t of document.querySelectorAll('.tab')) t.onclick = () => { ui.tab = t.dataset.tab; sel = new Set(); persist(); render(); };
  window.addEventListener('message', (ev) => { if (ev.data.type === 'data') { data = ev.data; render(); } });
  $('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
  vscode.postMessage({ type: 'ready' });
})();
