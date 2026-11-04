// panel request http.me (webview, JS vanilla). Fungsi murni di atas diekspor ke Node untuk unit test;
// UI hanya jalan di webview (acquireVsCodeApi ada). State request dipegang extension host, panel mengirim 'edit'.
(function () {
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'QUERY'];

  /** query URL -> baris Params; nilai mentah (tidak di-decode) supaya variabel dan %xx tetap seperti diketik */
  function urlToParams(url) {
    const q = url.indexOf('?');
    if (q < 0) return [];
    const hash = url.indexOf('#', q);
    const query = url.slice(q + 1, hash < 0 ? undefined : hash);
    return query.split('&').filter((s) => s !== '').map((s) => {
      const eq = s.indexOf('=');
      return eq < 0 ? { key: s, value: '', enabled: true } : { key: s.slice(0, eq), value: s.slice(eq + 1), enabled: true };
    });
  }

  /** Params aktif -> query URL; base & #fragment dipertahankan. shortcut: `a=` (nilai kosong) ditulis `a` */
  function paramsToUrl(url, params) {
    const hash = url.indexOf('#');
    const frag = hash < 0 ? '' : url.slice(hash);
    const noFrag = hash < 0 ? url : url.slice(0, hash);
    const q = noFrag.indexOf('?');
    const base = q < 0 ? noFrag : noFrag.slice(0, q);
    const query = params.filter((p) => p.enabled && p.key !== '').map((p) => (p.value === '' ? p.key : `${p.key}=${p.value}`)).join('&');
    return `${base}${query ? `?${query}` : ''}${frag}`;
  }

  const api = { METHODS, urlToParams, paramsToUrl };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  /** request seperti ParsedRequest di httpFile.ts */
  let req;
  let editTimer;

  const post = (msg) => vscode.postMessage(msg);
  /** kirim perubahan ke extension host (ditulis ke dokumen .http), digabung tiap 250 ms */
  function changed() {
    clearTimeout(editTimer);
    editTimer = setTimeout(() => post({ type: 'edit', req }), 250);
    counts();
  }
  function flush() {
    if (editTimer === undefined) return;
    clearTimeout(editTimer);
    editTimer = undefined;
    post({ type: 'edit', req });
  }

  function el(tag, props, children) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const c of children || []) e.append(c);
    return e;
  }

  /** tabel key/value yang bisa diedit + satu baris kosong di bawah untuk menambah */
  function kvTable(tbody, rows, keyName, onChange) {
    tbody.replaceChildren();
    const addRow = (row, isNew) => {
      const tr = el('tr', { className: row.enabled ? '' : 'off' });
      const on = el('input', { type: 'checkbox', checked: row.enabled, title: 'Enabled' });
      const k = el('input', { type: 'text', value: row[keyName], placeholder: isNew ? 'Key' : '', spellcheck: false });
      const v = el('input', { type: 'text', value: row.value, placeholder: isNew ? 'Value' : '', spellcheck: false });
      const del = el('button', { className: 'del', type: 'button', title: 'Remove', textContent: '✕' });
      tr.append(el('td', { className: 'c' }, [on]), el('td', {}, [k]), el('td', {}, [v]), el('td', { className: 'x' }, [del]));
      tbody.append(tr);
      const live = () => {
        if (isNew) { isNew = false; rows.push(row); k.placeholder = ''; v.placeholder = ''; addRow({ [keyName]: '', value: '', enabled: true }, true); }
      };
      on.onchange = () => { live(); row.enabled = on.checked; tr.className = row.enabled ? '' : 'off'; onChange(false); };
      k.oninput = () => { live(); row[keyName] = k.value; onChange(false); };
      v.oninput = () => { live(); row.value = v.value; onChange(false); };
      del.onclick = () => { if (isNew) return; rows.splice(rows.indexOf(row), 1); onChange(true); };
    };
    for (const r of rows) addRow(r, false);
    addRow({ [keyName]: '', value: '', enabled: true }, true);
  }

  let params = [];
  function renderParams() {
    params = [...urlToParams(req.url), ...req.disabledParams.map((p) => ({ ...p, enabled: false }))];
    kvTable($('paramRows'), params, 'key', (structural) => {
      req.url = paramsToUrl(req.url, params);
      req.disabledParams = params.filter((p) => !p.enabled && p.key !== '').map(({ key, value }) => ({ key, value }));
      $('url').value = req.url;
      if (structural) renderParams();
      changed();
    });
  }
  function renderHeaders() {
    kvTable($('headerRows'), req.headers, 'name', (structural) => {
      if (structural) renderHeaders();
      changed();
    });
  }
  function counts() {
    const p = urlToParams(req.url).length;
    $('nParams').textContent = p ? String(p) : '';
    const on = req.headers.filter((h) => h.enabled && h.name).length;
    $('nHeaders').textContent = req.headers.length ? `${on}/${req.headers.filter((h) => h.name).length}` : '';
  }

  function renderMethod() {
    $('method').className = `m-${req.method}`;
  }

  function renderRequest() {
    $('method').value = req.method;
    $('url').value = req.url;
    renderMethod();
    renderParams();
    renderHeaders();
    counts();
  }

  $('method').replaceChildren(...METHODS.map((m) => el('option', { value: m, textContent: m, className: `m-${m}` })));
  $('method').onchange = () => { req.method = $('method').value; renderMethod(); changed(); };
  $('url').oninput = () => { req.url = $('url').value; renderParams(); changed(); };
  for (const b of $('reqTabs').querySelectorAll('button')) {
    b.onclick = () => {
      for (const x of $('reqTabs').querySelectorAll('button')) x.classList.toggle('on', x === b);
      for (const p of document.querySelectorAll('.reqpanes > .pane')) p.hidden = p.id !== `p-${b.dataset.p}`;
    };
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      req = m.req;
      renderRequest();
    }
  });
  window.addEventListener('blur', flush);
  post({ type: 'ready' });
})();
