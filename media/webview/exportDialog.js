// Export dialog: format + opsi + tree centang bertingkat + peringatan + pratinjau live (webview, JS vanilla).
// Fungsi murni diekspor ke Node untuk unit test.
(function () {
  /** daftar {path, method?} -> tree {name, children[], item?}; folder sebelum file */
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
  function leaves(node) { return node.item ? [node.item.path] : node.children.flatMap(leaves); }
  /** status centang folder dari path di bawahnya */
  function folderState(paths, checked) {
    const n = paths.filter((p) => checked.has(p)).length;
    return n === 0 ? 'none' : n === paths.length ? 'all' : 'some';
  }
  const extFor = (format, yaml) => (format === 'postman' ? 'postman_collection.json' : `openapi.${yaml ? 'yaml' : 'json'}`);
  /** ganti ekstensi file hasil hanya bila path masih memakai ekstensi default sebelumnya (path kustom tidak diubah) */
  const swapExt = (file, from, to) => (file.endsWith(`.${from}`) ? `${file.slice(0, -from.length)}${to}` : file);
  const api = { buildTree, leaves, folderState, extFor, swapExt };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, children) => { const e = Object.assign(document.createElement(tag), props || {}); for (const c of children || []) e.append(c); return e; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  let st = { name: '', items: [], out: '' };
  const checked = new Set();
  const closed = new Set();
  let seq = 0;
  let timer;
  let prevExt = extFor('postman', false);

  const opts = () => ({
    format: $('format').value, yaml: $('yaml').checked && $('format').value !== 'postman', out: $('out').value, selected: [...checked],
    translateScripts: $('optScripts').checked, env: $('optEnv').checked, jetbrains: $('optJetbrains').checked, secrets: $('optSecrets').checked,
  });
  function schedule() {
    clearTimeout(timer);
    $('preview').classList.add('busy');
    timer = setTimeout(() => { seq += 1; vscode.postMessage({ type: 'preview', seq, ...opts() }); }, 150);
  }
  function showOptions() {
    const pm = $('format').value === 'postman';
    $('yamlBox').hidden = pm; $('optScriptsBox').hidden = !pm; $('optEnvBox').hidden = !pm;
    $('optJetbrainsBox').hidden = !pm || !$('optEnv').checked; $('optSecretsBox').hidden = !pm || !$('optEnv').checked;
  }
  function update() {
    $('count').textContent = `${checked.size} of ${plural(st.items.length, 'request file')} selected`;
    $('go').disabled = checked.size === 0 || !$('out').value.trim();
    const warn = el('span', { className: 'chip' }); warn.append(el('b', { textContent: String(st.items.length) }), ' files');
    $('chips').replaceChildren(warn);
  }
  function item(n) {
    const it = n.item;
    const cb = el('input', { type: 'checkbox', checked: checked.has(it.path), onchange: () => { if (cb.checked) checked.add(it.path); else checked.delete(it.path); update(); schedule(); } });
    const method = it.method ? el('span', { className: `method ${it.method}`, textContent: it.method }) : el('span', { className: 'method other', textContent: 'file' });
    const row = el('label', { className: 'item' }, [cb, method, el('span', { className: 'name', textContent: n.name })]);
    if (it.title && it.title !== n.name.replace(/\.http$/, '')) row.append(el('span', { className: 'n', textContent: it.title }));
    return el('li', {}, [row]);
  }
  function node(n, q, path) {
    if (n.item) { const t = q.trim().toLowerCase(); return !t || [n.item.path, n.item.method, n.item.title].some((x) => (x || '').toLowerCase().includes(t)) ? item(n) : null; }
    const kids = n.children.map((c) => node(c, q, `${path}/${n.name}`)).filter(Boolean);
    if (!kids.length) return null;
    const paths = leaves(n);
    const key = `${path}/${n.name}`;
    const state = folderState(paths, checked);
    const cb = el('input', { type: 'checkbox', checked: state === 'all', indeterminate: state === 'some', onclick: (e) => e.stopPropagation(),
      onchange: () => { for (const p of paths) { if (cb.checked) checked.add(p); else checked.delete(p); } render(); schedule(); } });
    const d = el('details', { open: q ? true : !closed.has(key), ontoggle: () => { if (d.open) closed.delete(key); else closed.add(key); } },
      [el('summary', {}, [cb, el('span', { className: 'folder', textContent: `${n.name}/` }), el('span', { className: 'n', textContent: plural(paths.length, 'request file') })]), el('ul', {}, kids)]);
    return el('li', {}, [d]);
  }
  function render() {
    $('badge').textContent = $('format').selectedOptions[0].textContent;
    $('sub').textContent = `${st.name}: choose what to include. The preview shows the file exactly as it will be written.`;
    const rows = buildTree(st.items).children.map((c) => node(c, $('filter').value, '')).filter(Boolean);
    $('tree').replaceChildren(...(rows.length ? rows : [el('li', { className: 'empty', textContent: st.items.length ? 'No requests match the filter.' : 'No .http files in this folder.' })]));
    update();
  }
  const setAll = (on) => { for (const i of st.items) if (on) checked.add(i.path); else checked.delete(i.path); render(); schedule(); };
  function onFormat() {
    const o = opts();
    const next = extFor(o.format, o.yaml);
    $('out').value = swapExt($('out').value, prevExt, next);
    prevExt = next;
    showOptions(); render(); schedule();
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      st = m; checked.clear(); for (const i of st.items) checked.add(i.path);
      $('out').value = m.out; prevExt = extFor('postman', false);
      showOptions(); render(); schedule();
    } else if (m.type === 'out') { $('out').value = m.out; update(); }
    else if (m.type === 'preview' && m.seq === seq) {
      $('preview').classList.remove('busy');
      $('previewError').hidden = !m.error; $('previewError').textContent = m.error || '';
      $('preview').textContent = m.error ? '' : m.text;
      $('previewInfo').textContent = m.error ? '' : `${plural(m.requests, 'request')}${m.skipped ? `, ${m.skipped} skipped` : ''}${m.files > 1 ? ` · ${m.files} files` : ''}`;
      $('warnings').replaceChildren(...(m.warnings || []).map((w) => el('li', { textContent: w })));
    }
  });
  for (const id of ['format', 'yaml']) $(id).onchange = onFormat;
  for (const id of ['optScripts', 'optEnv', 'optJetbrains', 'optSecrets']) $(id).onchange = () => { showOptions(); schedule(); };
  $('out').oninput = () => { prevExt = ''; update(); };
  $('filter').oninput = render;
  $('all').onclick = () => setAll(true);
  $('none').onclick = () => setAll(false);
  $('browse').onclick = () => vscode.postMessage({ type: 'browse', ...opts() });
  $('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
  $('go').onclick = () => vscode.postMessage({ type: 'export', ...opts() });
  vscode.postMessage({ type: 'ready' });
})();
