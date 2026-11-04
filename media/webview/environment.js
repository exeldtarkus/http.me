// editor Environment (webview, JS vanilla). Fungsi murni di atas diekspor ke Node untuk unit test.
// Isi file dipegang extension host: tabel mengirim operasi ('edit', 'addKey', 'renameKey', ...), host menulis dokumen JSON.
(function () {
  /** nama kosong / duplikat per indeks baris (sama dengan validateVars di environments.ts) */
  function rowErrors(vars) {
    const count = new Map();
    for (const x of vars) count.set(x.key.trim(), (count.get(x.key.trim()) || 0) + 1);
    const out = {};
    vars.forEach((x, i) => {
      const k = x.key.trim();
      if (!k) out[i] = 'Variable name is required';
      else if (count.get(k) > 1) out[i] = `Duplicate variable "${k}"`;
    });
    return out;
  }

  /** indeks baris yang tampil: cari di nama & nilai (secret hanya nama), NULL only */
  function visibleRows(vars, current, query, nullOnly) {
    const q = query.trim().toLowerCase();
    return vars.map((x, i) => i).filter((i) => {
      const x = vars[i];
      if (nullOnly && !(x.value === null && !x.secret)) return false;
      if (!q) return true;
      return [x.key, x.secret ? '' : x.value ?? '', x.secret ? '' : current[x.key] ?? ''].some((s) => s.toLowerCase().includes(q));
    });
  }

  /** drag: pindah baris `from` ke posisi sebelum `to` (to = panjang = paling bawah) */
  function moveRow(vars, from, to) {
    const out = vars.slice();
    const [x] = out.splice(from, 1);
    out.splice(to > from ? to - 1 : to, 0, x);
    return out;
  }

  /** tombol di kolom Add variable: Enter = tambah (fokus tetap), Tab = tambah lalu ke Initial value; kosong = Tab biasa */
  function addKeyAction(key, existing, k, shift) {
    if (k !== 'Enter' && (k !== 'Tab' || shift)) return 'none';
    const name = key.trim();
    if (!name) return k === 'Enter' ? 'invalid' : 'none';
    if (existing.includes(name)) return 'duplicate';
    return k === 'Enter' ? 'add-stay' : 'add-value';
  }

  const api = { rowErrors, visibleRows, moveRow, addKeyAction };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  /** ikon tempat sampah untuk tombol hapus (bukan ✕) */
  const TRASH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.8 9.5h6.4l.8-9.5M6.6 7v4.5M9.4 7v4.5"/></svg>';
  const $ = (id) => document.getElementById(id);
  const post = (m) => vscode.postMessage(m);
  let st = { vars: [], current: {}, secretSet: {} };
  let vars = [];
  let editTimer;
  const shown = {}; // secret yang sedang ditampilkan sementara
  let openNull = null; // key NULL yang sedang diisi

  function el(tag, props, children) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const c of children || []) e.append(c);
    return e;
  }

  function sendEdit() {
    const errs = rowErrors(vars);
    const list = Object.entries(errs);
    $('errors').hidden = !list.length;
    $('errors').textContent = list.length ? `Not saved: ${list.map(([i, m]) => `row ${Number(i) + 1}: ${m}`).join('; ')}` : '';
    for (const tr of $('rows').querySelectorAll('tr[data-i]')) tr.classList.toggle('bad', tr.dataset.i in errs);
    if (list.length) return;
    clearTimeout(editTimer);
    editTimer = setTimeout(() => { editTimer = undefined; post({ type: 'edit', vars }); }, 250);
  }

  function flushEdit() {
    if (editTimer === undefined) return;
    clearTimeout(editTimer);
    editTimer = undefined;
    post({ type: 'edit', vars });
  }

  function valueCell(x) {
    const box = el('div', { className: 'val' });
    if (x.secret) {
      const has = st.secretSet[x.key];
      if (!has && openNull !== x.key) {
        box.append(el('button', { className: 'null', type: 'button', textContent: 'NULL', title: 'No value yet: click to fill in', onclick: () => { openNull = x.key; render(); } }));
        return box;
      }
      const inp = el('input', { type: shown[x.key] !== undefined ? 'text' : 'password', value: shown[x.key] ?? (has ? '••••••••' : ''), spellcheck: false, placeholder: 'Secret value' });
      inp.onfocus = () => { if (shown[x.key] === undefined && has) inp.value = ''; };
      inp.onchange = () => { openNull = null; delete shown[x.key]; post({ type: 'setSecretValue', key: x.key, value: inp.value }); };
      const eye = el('button', { className: `mini${shown[x.key] !== undefined ? ' on' : ''}`, type: 'button', textContent: '👁', title: shown[x.key] !== undefined ? 'Hide' : 'Show' });
      eye.onclick = () => { if (shown[x.key] !== undefined) { delete shown[x.key]; render(); } else post({ type: 'showSecret', key: x.key }); };
      const clear = el('button', { className: 'mini', type: 'button', textContent: '⊘', title: 'Set NULL' });
      clear.onclick = () => post({ type: 'setSecretValue', key: x.key });
      box.append(inp, eye, clear);
      if (openNull === x.key) setTimeout(() => inp.focus());
      return box;
    }
    if (x.value === null && openNull !== x.key) {
      box.append(el('button', { className: 'null', type: 'button', textContent: 'NULL', title: 'No value yet: click to fill in', onclick: () => { openNull = x.key; render(); } }));
      return box;
    }
    const inp = el('input', { type: 'text', value: x.value ?? '', spellcheck: false, placeholder: x.value === null ? 'Value' : '' });
    inp.oninput = () => { x.value = inp.value; sendEdit(); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } };
    // blur dari input yang sudah dilepas render ulang (state echo) tidak boleh menutup editor
    inp.onblur = () => { if (rendering || !inp.isConnected || !document.hasFocus()) return; flushEdit(); if (openNull === x.key) { openNull = null; if (x.value === null) render(); } };
    const setNull = el('button', { className: 'mini', type: 'button', textContent: '⊘', title: 'Set NULL' });
    setNull.onclick = () => { x.value = null; openNull = null; render(); sendEdit(); };
    box.append(inp, setNull);
    return box;
  }

  let dragFrom = -1;
  let refocusAdd = false; // Enter di Add variable: setelah digambar ulang fokus kembali ke Add
  let rendering = false; // render() melepas input yang fokus; blur dari pelepasan itu bukan keputusan user
  function render() {
    $('fileError').hidden = !st.error;
    $('fileError').textContent = st.error ? `${st.error}. Fix the file with Open as Text.` : '';
    $('editor').hidden = !!st.error;
    $('title').textContent = st.name;
    $('save').disabled = !st.dirty;
    $('title').disabled = !!st.globals;
    $('activeBadge').hidden = !st.active;
    $('setActive').hidden = !!st.active || !!st.globals;
    $('reset').hidden = $('persist').hidden = !!st.globals;
    if (st.error) return;
    rendering = true;
    const nulls = vars.filter((x) => (x.secret ? !st.secretSet[x.key] : x.value === null)).length;
    $('nullCount').textContent = nulls ? `${nulls} NULL` : '';
    const rows = visibleRows(vars, st.current, $('search').value, $('nullOnly').checked);
    const errs = rowErrors(vars);
    $('rows').replaceChildren();
    for (const i of rows) {
      const x = vars[i];
      const tr = el('tr', { className: `${x.enabled === false ? 'off' : ''}${i in errs ? ' bad' : ''}`, draggable: true });
      tr.dataset.i = String(i);
      tr.dataset.key = x.key;
      const on = el('input', { type: 'checkbox', checked: x.enabled !== false, title: 'Enabled' });
      on.onchange = () => { if (on.checked) delete x.enabled; else x.enabled = false; render(); sendEdit(); };
      const key = el('input', { type: 'text', className: 'key', value: x.key, spellcheck: false, title: errs[i] || '' });
      const old = x.key;
      key.oninput = () => { x.key = key.value; sendEditCheckOnly(); };
      key.onchange = () => {
        const errsNow = rowErrors(vars);
        if (i in errsNow) return;
        post({ type: 'renameKey', from: old, to: key.value.trim() });
      };
      const cur = x.secret || st.globals ? el('span', { className: 'dots', textContent: '—', title: st.globals ? 'Globals have one value' : 'Secrets have one value' })
        : el('input', { type: 'text', value: st.current[x.key] ?? '', placeholder: x.value ?? '', spellcheck: false, title: 'Current value (only on this computer); empty = use the initial value' });
      if (cur.tagName === 'INPUT') cur.onchange = () => post({ type: 'setCurrent', key: x.key, value: cur.value === '' ? undefined : cur.value });
      const sec = el('input', { type: 'checkbox', checked: !!x.secret, title: 'Secret: the value is kept in VS Code SecretStorage' });
      sec.onchange = () => post({ type: 'setSecret', key: x.key, secret: sec.checked });
      const del = el('button', { className: 'del', type: 'button', innerHTML: TRASH, title: 'Delete variable', ariaLabel: 'Delete variable' });
      del.onclick = () => post({ type: 'deleteKey', key: x.key });
      tr.append(el('td', { className: 'g' }, [el('span', { className: 'grip', textContent: '⋮⋮', title: 'Drag to reorder' })]), el('td', { className: 'c' }, [on]),
        el('td', {}, [key]), el('td', {}, [valueCell(x)]), el('td', {}, [cur]), el('td', { className: 's' }, [sec]), el('td', { className: 'x' }, [del]));
      tr.ondragstart = (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; };
      tr.ondragover = (e) => { if (dragFrom < 0) return; e.preventDefault(); tr.classList.add('drop'); };
      tr.ondragleave = () => tr.classList.remove('drop');
      tr.ondrop = (e) => { e.preventDefault(); tr.classList.remove('drop'); if (dragFrom >= 0 && dragFrom !== i) { vars = moveRow(vars, dragFrom, i); render(); sendEdit(); } dragFrom = -1; };
      $('rows').append(tr);
    }
    // baris terakhir: Add variable (ke semua Environment dengan NULL); Enter = tetap di sini, Tab = lanjut isi Initial value
    // Initial value yang sedang diisi (openNull) difokuskan di sini, setelah baris digambar, agar tidak balapan dengan render ulang
    const fill = openNull !== null ? [...$('rows').querySelectorAll('tr[data-key]')].find((r) => r.dataset.key === openNull) : undefined;
    fill?.querySelector('.val input[type=text]')?.focus();
    const add = el('input', { type: 'text', placeholder: 'Add variable (Enter / Tab)', spellcheck: false, id: 'addKey' });
    add.oninput = () => {
      add.setCustomValidity('');
      const name = add.value.trim();
      const dup = !!name && vars.some((x) => x.key === name);
      add.classList.toggle('bad', dup);
      $('errors').hidden = !dup;
      $('errors').textContent = dup ? `Variable "${name}" already exists` : '';
    };
    add.onkeydown = (e) => {
      const act = addKeyAction(add.value, vars.map((x) => x.key), e.key, e.shiftKey);
      if (act === 'none') return;
      e.preventDefault();
      const k = add.value.trim();
      if (act === 'duplicate' || act === 'invalid') { add.setCustomValidity(act === 'duplicate' ? `Duplicate variable "${k}"` : ''); add.reportValidity(); return; }
      // Tab: setelah host menulis key baru, editor Initial value baris itu dibuka & difokus (openNull)
      if (act === 'add-value') openNull = k;
      else refocusAdd = true;
      post({ type: 'addKey', key: k });
      add.value = '';
    };
    if (refocusAdd) { refocusAdd = false; setTimeout(() => $('addKey')?.focus()); }
    $('rows').append(el('tr', { className: 'add' }, [el('td'), el('td'), el('td', {}, [add]), el('td', { colSpan: 4 })]));
    rendering = false;
  }
  /** nama sedang diketik: tandai merah tanpa menggambar ulang (fokus tetap) */
  function sendEditCheckOnly() {
    const errs = rowErrors(vars);
    for (const tr of $('rows').querySelectorAll('tr[data-i]')) tr.classList.toggle('bad', tr.dataset.i in errs);
  }

  function focusKey(key, mode) {
    if (mode === 'add') {
      $('search').value = '';
      $('nullOnly').checked = false;
      render();
      const add = $('addKey');
      add.value = key;
      add.focus();
      return;
    }
    const x = vars.find((v) => v.key === key);
    if (x && mode === 'fill' && (x.secret ? !st.secretSet[key] : x.value === null)) openNull = key;
    $('search').value = '';
    $('nullOnly').checked = false;
    render();
    const tr = [...$('rows').querySelectorAll('tr[data-key]')].find((r) => r.dataset.key === key);
    if (!tr) return;
    tr.classList.add('hl');
    tr.scrollIntoView({ block: 'center' });
    setTimeout(() => tr.classList.remove('hl'), 1500);
  }

  $('title').onclick = () => post({ type: 'rename' });
  $('setActive').onclick = () => post({ type: 'setActive' });
  $('compare').onclick = () => post({ type: 'compare' });
  $('openAsText').onclick = () => post({ type: 'openAsText' });
  $('save').onclick = () => { post({ type: 'save' }); };
  $('reset').onclick = () => post({ type: 'resetCurrent' });
  $('persist').onclick = () => post({ type: 'persistAll' });
  $('search').oninput = render;
  $('nullOnly').onchange = render;

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      st = m;
      // ketikan yang belum terkirim tidak ditimpa: echo dokumennya datang setelah 'edit' terkirim
      if (editTimer === undefined) vars = (m.vars || []).map((x) => ({ ...x }));
      const active = document.activeElement;
      const keep = active?.tagName === 'INPUT' && active.type === 'text' && $('rows').contains(active) ? [active.closest('tr')?.dataset.i, [...active.closest('tr').children].findIndex((td) => td.contains(active)), active.selectionStart] : undefined;
      render();
      if (keep) {
        const td = $('rows').querySelector(`tr[data-i="${keep[0]}"]`)?.children[keep[1]];
        const inp = td?.querySelector('input[type=text]');
        if (inp) { inp.focus(); inp.setSelectionRange(keep[2], keep[2]); }
      }
    } else if (m.type === 'focus') focusKey(m.key, m.mode);
    else if (m.type === 'secret') { if (m.value !== null) shown[m.key] = m.value; render(); }
  });
  post({ type: 'ready' });
})();
