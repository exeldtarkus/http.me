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

  const CONTENT_TYPES = { json: 'application/json', text: 'text/plain', xml: 'application/xml', form: 'application/x-www-form-urlencoded' };
  const FAMILY = { json: /[/+]json\b/i, xml: /[/+]xml\b/i, form: /x-www-form-urlencoded/i, text: /^text\/plain\b/i };

  /** pilih jenis body: Content-Type diatur (nilai user dipertahankan bila jenisnya sama); none = header & body dihapus */
  function setBodyType(req, type) {
    const isCt = (h) => h.name.toLowerCase() === 'content-type';
    const cur = req.headers.find((h) => h.enabled && isCt(h));
    req.headers = req.headers.filter((h) => !isCt(h) || (type !== 'none' && h === cur));
    if (type === 'none') req.body = '';
    else if (!cur) req.headers.push({ name: 'Content-Type', value: CONTENT_TYPES[type], enabled: true });
    else if (!FAMILY[type].test(cur.value)) cur.value = CONTENT_TYPES[type];
    req.bodyType = type;
  }

  const decode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } }; // %xx rusak: dibiarkan apa adanya
  /** encode bagian form; variabel kurung kurawal ganda dibiarkan supaya diganti saat Send */
  const encode = (s) => s.split(/(\{\{[^}]*\}\})/).map((p, i) => (i % 2 ? p : encodeURIComponent(p))).join('');

  /** body x-www-form-urlencoded -> baris key/value */
  function formToRows(body) {
    return body.split('&').filter((s) => s !== '').map((s) => {
      const eq = s.indexOf('=');
      return { key: decode(eq < 0 ? s : s.slice(0, eq)), value: eq < 0 ? '' : decode(s.slice(eq + 1)), enabled: true };
    });
  }
  /** baris aktif -> body. shortcut: baris form nonaktif tidak disimpan ke .http (hilang saat file dibuka ulang) */
  const rowsToForm = (rows) => rows.filter((r) => r.enabled && r.key !== '').map((r) => `${encode(r.key)}=${encode(r.value)}`).join('&');

  const api = { METHODS, urlToParams, paramsToUrl, setBodyType, formToRows, rowsToForm };
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
    $('bodyWarn').hidden = !(['GET', 'HEAD'].includes(req.method) && req.body !== '');
  }

  let formRows = [];
  function renderBody() {
    for (const r of document.getElementsByName('bt')) r.checked = r.value === req.bodyType;
    const form = req.bodyType === 'form';
    $('bodyText').hidden = form || req.bodyType === 'none';
    $('formTable').hidden = !form;
    if (form) {
      formRows = formToRows(req.body);
      kvTable($('formRows'), formRows, 'key', (structural) => {
        req.body = rowsToForm(formRows);
        if (structural) renderBody();
        renderMethod();
        changed();
      });
    } else $('bodyText').value = req.body;
  }

  function renderRequest() {
    $('method').value = req.method;
    $('url').value = req.url;
    renderMethod();
    renderParams();
    renderHeaders();
    renderBody();
    renderSettings();
    counts();
  }

  function renderSettings() {
    $('redir').value = req.followRedirects ? 'yes' : 'no';
    $('tls').value = req.insecure ? 'ignore' : 'verify';
    $('tmo').value = req.timeoutSec === undefined ? '' : String(req.timeoutSec);
  }

  $('method').replaceChildren(...METHODS.map((m) => el('option', { value: m, textContent: m, className: `m-${m}` })));
  $('method').onchange = () => { req.method = $('method').value; renderMethod(); changed(); };
  $('url').oninput = () => { req.url = $('url').value; renderParams(); changed(); };
  $('bodyText').oninput = () => { req.body = $('bodyText').value; renderMethod(); changed(); };
  for (const r of document.getElementsByName('bt')) {
    r.onchange = () => {
      // text -> form: body lama yang bukan key=value tetap utuh di .http sampai tabel form diedit
      setBodyType(req, r.value);
      renderHeaders();
      renderBody();
      renderMethod();
      changed();
    };
  }
  for (const b of $('reqTabs').querySelectorAll('button')) {
    b.onclick = () => {
      for (const x of $('reqTabs').querySelectorAll('button')) x.classList.toggle('on', x === b);
      for (const p of document.querySelectorAll('.reqpanes > .pane')) p.hidden = p.id !== `p-${b.dataset.p}`;
    };
  }

  let resTab = 'rbody';
  function showResTab(name) {
    resTab = name;
    for (const x of $('resTabs').querySelectorAll('button')) x.classList.toggle('on', x.dataset.r === name);
    for (const p of document.querySelectorAll('.resbody > .pane')) p.hidden = p.id !== `r-${name}`;
  }
  for (const b of $('resTabs').querySelectorAll('button')) b.onclick = () => showResTab(b.dataset.r);

  /** view dari host: running | response | error | cancelled | undefined (belum pernah Send) */
  let running = false;
  function renderView(view) {
    running = view?.kind === 'running' || view?.kind === 'queued';
    $('send').textContent = running ? 'Cancel' : 'Send';
    $('send').classList.toggle('busy', running);
    $('send').title = running ? 'Cancel' : 'Send (Ctrl+Enter)';
    $('ldCancel').disabled = false;
    $('ldCancel').textContent = 'Cancel';
    $('loading').hidden = !running;
    $('ldSub').textContent = running ? view.label : '';
    $('ldText').textContent = view?.kind === 'queued' ? view.position : 'Sending request';
    const res = view?.kind === 'response' ? view : undefined;
    $('st').textContent = res ? res.status : view?.kind === 'cancelled' ? 'Cancelled' : view?.kind === 'error' ? 'Error' : '';
    $('st').className = `status ${res ? res.statusClass : view?.kind === 'error' ? 'st-5' : 'st-1'}`;
    $('ms').textContent = res ? res.time : '';
    $('sz').textContent = res ? res.size : '';
    $('resEmpty').hidden = !!view && !running;
    $('resBody').className = `code${view?.kind === 'error' ? ' error' : ''}`;
    if (res) $('resBody').innerHTML = res.bodyHtml; // sudah di-escape di host (response.ts)
    else $('resBody').textContent = view?.kind === 'error' ? view.message : view?.kind === 'cancelled' ? 'The request was cancelled.' : '';
    $('resHeaders').replaceChildren(...(res ? res.headers : []).map(([k, v]) => el('tr', {}, [el('td', { textContent: k }), el('td', { textContent: v })])));
    $('nResHeaders').textContent = res ? String(res.headers.length) : '';
    $('allow').hidden = !res?.allow;
    if (res?.allow) $('allow').replaceChildren(el('b', { textContent: 'Allowed methods' }), res.allow.length ? res.allow.join(', ') : 'none listed by the server');
    $('bodyNote').hidden = !res?.note;
    $('bodyNoteText').textContent = res?.note ?? '';
    $('openBody').hidden = !res?.canOpen;
    $('saveBody').hidden = !res?.canSave;
    $('resBodyTab').disabled = !!res?.head;
    showResTab(res?.head ? 'rheaders' : resTab);
  }

  function sendNow() {
    flush();
    post({ type: 'send', req });
  }
  function cancel() {
    $('ldCancel').disabled = true;
    $('ldCancel').textContent = 'Cancelling…';
    post({ type: 'cancel' });
  }
  $('send').onclick = () => (running ? cancel() : sendNow());
  $('ldCancel').onclick = cancel;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendNow(); }
  });
  $('redir').onchange = () => { req.followRedirects = $('redir').value === 'yes'; changed(); };
  $('tls').onchange = () => { req.insecure = $('tls').value === 'ignore'; changed(); };
  $('tmo').oninput = () => {
    const n = parseInt($('tmo').value, 10);
    req.timeoutSec = n > 0 ? n : undefined;
    changed();
  };
  $('openBody').onclick = () => post({ type: 'openBody' });
  $('saveBody').onclick = () => post({ type: 'saveBody' });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      req = m.req;
      renderRequest();
    }
    if ('view' in m) renderView(m.view);
  });
  window.addEventListener('blur', flush);
  post({ type: 'ready' });
})();
