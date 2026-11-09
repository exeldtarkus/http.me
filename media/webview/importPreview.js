// Import preview: tree centang folder → request, folder tujuan, konflik Skip / Overwrite / Keep both (webview, JS vanilla).
// Fungsi murni diekspor ke Node untuk unit test.
(function () {
  /** daftar {path, ...} → tree {name, children[], item?}; folder diurutkan sebelum file */
  function buildTree(items) {
    const root = { name: '', children: [] };
    for (const item of items) {
      const parts = item.path.split('/');
      let cur = root;
      parts.forEach((name, i) => {
        let next = cur.children.find((c) => c.name === name && (i < parts.length - 1) === !c.item);
        if (!next) { next = { name, children: [] }; if (i === parts.length - 1) next.item = item; cur.children.push(next); }
        cur = next;
      });
    }
    const sort = (n) => { n.children.sort((a, b) => (!!a.item - !!b.item) || a.name.localeCompare(b.name)); n.children.forEach(sort); };
    sort(root);
    return root;
  }
  /** path item di bawah node */
  function leaves(node) { return node.item ? [node.item.path] : node.children.flatMap(leaves); }
  /** item yang cocok dengan teks filter (nama, method, judul, peringatan); kosong = semua */
  function matches(item, q) {
    const t = q.trim().toLowerCase();
    return !t || [item.path, item.method, item.title, ...item.warnings].some((x) => (x || '').toLowerCase().includes(t));
  }
  const api = { buildTree, leaves, matches };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, children) => { const e = Object.assign(document.createElement(tag), props || {}); for (const c of children || []) e.append(c); return e; };
  let st = { items: [], name: '', dir: '', format: '' };
  const checked = new Set();
  const conflict = new Map();
  const closed = new Set();
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function chips() {
    const reqs = st.items.filter((i) => i.method).length;
    const warns = st.items.reduce((n, i) => n + i.warnings.length, 0);
    const exist = st.items.filter((i) => i.exists).length;
    const b = (n, t) => { const s = el('span', { className: `chip ${t || ''}` }); s.append(el('b', { textContent: String(n) }), ` ${t === 'warn' ? (n === 1 ? 'warning' : 'warnings') : t === 'exists' ? 'already exist' : ''}`); return s; };
    const out = [];
    const files = el('span', { className: 'chip' }); files.append(el('b', { textContent: String(st.items.length) }), ' files'); out.push(files);
    const rq = el('span', { className: 'chip' }); rq.append(el('b', { textContent: String(reqs) }), reqs === 1 ? ' request' : ' requests'); out.push(rq);
    if (warns) out.push(b(warns, 'warn'));
    if (exist) out.push(b(exist, 'exists'));
    $('chips').replaceChildren(...out);
    $('confBox').hidden = !exist;
  }
  function update() {
    $('count').textContent = `${checked.size} of ${plural(st.items.length, 'file')} selected`;
    $('go').disabled = checked.size === 0;
  }
  function item(n) {
    const it = n.item;
    const cb = el('input', { type: 'checkbox', checked: checked.has(it.path), onchange: () => { if (cb.checked) checked.add(it.path); else checked.delete(it.path); update(); } });
    const method = it.method ? el('span', { className: `method ${it.method}`, textContent: it.method }) : el('span', { className: 'method other', textContent: it.kind || 'file' });
    const row = el('label', { className: 'item' }, [cb, method, el('span', { className: `name${it.method ? '' : ' dim'}`, textContent: n.name })]);
    if (it.title && it.title !== n.name.replace(/\.http$/, '')) row.append(el('span', { className: 'n', textContent: it.title }));
    if (it.exists) {
      row.append(el('span', { className: 'tag exists', textContent: 'exists' }));
      const sel = el('select', { onchange: () => conflict.set(it.path, sel.value), title: 'When this file already exists' }, [['skip', 'Skip'], ['overwrite', 'Overwrite'], ['keep', 'Keep both']].map(([v, t]) => el('option', { value: v, textContent: t, selected: (conflict.get(it.path) || 'skip') === v })));
      row.append(sel);
    }
    if (it.warnings.length) row.append(el('span', { className: 'tag warn', textContent: `! ${plural(it.warnings.length, 'warning')}` }));
    const li = el('li', {}, [row]);
    if (it.warnings.length) li.append(el('div', { className: 'warns', textContent: it.warnings.join(' · ') }));
    return li;
  }
  function node(n, q, path) {
    if (n.item) return matches(n.item, q) ? item(n) : null;
    const kids = n.children.map((c) => node(c, q, `${path}/${n.name}`)).filter(Boolean);
    if (!kids.length) return null;
    const paths = leaves(n);
    const key = `${path}/${n.name}`;
    const cb = el('input', { type: 'checkbox', checked: paths.every((p) => checked.has(p)), indeterminate: paths.some((p) => checked.has(p)) && !paths.every((p) => checked.has(p)),
      onclick: (e) => e.stopPropagation(), onchange: () => { for (const p of paths) { if (cb.checked) checked.add(p); else checked.delete(p); } render(); } });
    const d = el('details', { open: q ? true : !closed.has(key), ontoggle: () => { if (d.open) closed.delete(key); else closed.add(key); } },
      [el('summary', {}, [cb, el('span', { className: 'folder', textContent: `${n.name}/` }), el('span', { className: 'n', textContent: plural(paths.length, 'file') })]), el('ul', {}, kids)]);
    return el('li', {}, [d]);
  }
  function render() {
    $('format').textContent = st.format;
    $('format').hidden = !st.format;
    $('sub').textContent = `${st.name}: review what will be created. Pick files, check the destination, then import.`;
    $('dir').value = st.dir;
    chips();
    const q = $('filter').value;
    const rows = buildTree(st.items).children.map((c) => node(c, q, '')).filter(Boolean);
    $('tree').replaceChildren(...(rows.length ? rows : [el('li', { className: 'empty', textContent: 'No files match the filter.' })]));
    update();
  }
  const setAll = (on) => { for (const i of st.items) if (on) checked.add(i.path); else checked.delete(i.path); render(); };
  const fold = (open) => { closed.clear(); if (!open) for (const d of document.querySelectorAll('details')) closed.add(d.querySelector('.folder').textContent); render(); };
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') { st = m; checked.clear(); for (const i of st.items) checked.add(i.path); render(); }
    if (m.type === 'dir') { st.dir = m.dir; st.items = m.items; render(); }
  });
  $('filter').oninput = render;
  $('all').onclick = () => setAll(true);
  $('none').onclick = () => setAll(false);
  $('expand').onclick = () => fold(true);
  $('collapse').onclick = () => fold(false);
  $('confAll').onchange = () => { for (const i of st.items) if (i.exists) conflict.set(i.path, $('confAll').value); render(); };
  $('browse').onclick = () => vscode.postMessage({ type: 'browse' });
  $('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
  $('go').onclick = () => vscode.postMessage({ type: 'import', selected: [...checked], conflicts: Object.fromEntries(conflict) });
  vscode.postMessage({ type: 'ready' });
})();
