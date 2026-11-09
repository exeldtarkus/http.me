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
  const api = { buildTree, leaves };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, children) => { const e = Object.assign(document.createElement(tag), props || {}); for (const c of children || []) e.append(c); return e; };
  let st = { items: [], name: '', dir: '' };
  const checked = new Set();
  const conflict = new Map();

  function update() {
    $('count').textContent = `${checked.size} of ${st.items.length} files selected`;
    $('go').disabled = checked.size === 0;
  }
  function node(n) {
    if (n.item) {
      const it = n.item;
      const cb = el('input', { type: 'checkbox', checked: checked.has(it.path), onchange: () => { if (cb.checked) checked.add(it.path); else checked.delete(it.path); update(); } });
      const line = el('label', { className: 'item' + (it.exists ? ' conflict' : '') }, [cb, ` ${n.name}`]);
      if (it.exists) {
        const sel = el('select', { onchange: () => conflict.set(it.path, sel.value) }, [['skip', 'Skip'], ['overwrite', 'Overwrite'], ['keep', 'Keep both']].map(([v, t]) => el('option', { value: v, textContent: t, selected: (conflict.get(it.path) || 'skip') === v })));
        line.append(' already exists ', sel);
      }
      return el('li', {}, [line, ...it.warnings.map((w) => el('div', { className: 'warn', textContent: '! ' + w }))]);
    }
    const paths = leaves(n);
    const cb = el('input', { type: 'checkbox', checked: paths.every((p) => checked.has(p)), onchange: () => { for (const p of paths) { if (cb.checked) checked.add(p); else checked.delete(p); } render(); } });
    return el('li', {}, [el('label', { className: 'folder' }, [cb, ` ${n.name}/ `, el('span', { className: 'count', textContent: `(${paths.length})` })]), el('ul', {}, n.children.map(node))]);
  }
  function render() {
    $('sub').textContent = `${st.name}: ${st.items.length} files. Nothing is written until you click Import.`;
    $('dir').value = st.dir;
    $('tree').replaceChildren(...buildTree(st.items).children.map(node));
    update();
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') { st = m; checked.clear(); for (const i of st.items) checked.add(i.path); render(); }
    if (m.type === 'dir') { st.dir = m.dir; st.items = m.items; render(); }
  });
  $('browse').onclick = () => vscode.postMessage({ type: 'browse' });
  $('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
  $('go').onclick = () => vscode.postMessage({ type: 'import', selected: [...checked], conflicts: Object.fromEntries(conflict) });
  vscode.postMessage({ type: 'ready' });
})();
