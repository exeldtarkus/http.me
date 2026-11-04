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

  // ---------- token variable (pola sama dengan findVarTokens di diagnostics.ts) ----------
  const DYNAMIC = ['$timestamp', '$isoTimestamp', '$guid', '$uuid', '$randomInt', '$datetime'];

  /** warna token: ok (ada nilai) / null (NULL di Environment aktif) / missing (tidak ditemukan) / dyn (variable dinamis) */
  function tokenClass(name, vars, fileVars) {
    if (name.startsWith('$')) return DYNAMIC.includes(name) ? 'dyn' : 'missing';
    if (fileVars.includes(name) || vars.ok.includes(name)) return 'ok';
    return vars.nulls.includes(name) ? 'null' : 'missing';
  }

  /** teks field -> potongan biasa + token {{…}} (untuk lapisan mirror) */
  function segments(text, vars, fileVars) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
      const name = m[1].split(/\s+/)[0];
      if (!name) continue;
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      out.push({ text: m[0], name, cls: tokenClass(name, vars, fileVars) });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }

  /** autocomplete {{ : awalan nama sebelum kursor, atau undefined bila kursor tidak di dalam {{ */
  function completionPrefix(before) {
    const m = /\{\{\s*([\w.$-]*)$/.exec(before);
    return m ? m[1] : undefined;
  }

  const api = { METHODS, urlToParams, paramsToUrl, setBodyType, formToRows, rowsToForm, tokenClass, segments, completionPrefix };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  /** request seperti ParsedRequest di httpFile.ts */
  let req;
  let editTimer;
  /** dari host: nama variable yang punya nilai / NULL di Environment aktif + Globals */
  let vars = { ok: [], nulls: [], names: [] };
  const fileVars = () => (req ? req.vars.map((v) => v.name) : []);

  const post = (msg) => vscode.postMessage(msg);
  /** kirim perubahan ke extension host (ditulis ke dokumen .http), digabung tiap 250 ms */
  function changed() {
    clearTimeout(editTimer);
    editTimer = setTimeout(() => post({ type: 'edit', req }), 250);
    counts();
    syncMirrors();
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
      tr.append(el('td', { className: 'c' }, [on]), el('td', {}, [mirror(k)]), el('td', {}, [mirror(v)]), el('td', { className: 'x' }, [del]));
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
      syncMirrors();
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
    $('bodyFileNote').hidden = !req.bodyFile;
    $('bodyFileNote').textContent = req.bodyFile ? `The body is read from ${req.bodyFile} when the request is sent.` : '';
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
    syncMirrors();
  }

  // ---------- lapisan mirror: teks field transparan, token digambar di bawahnya (caret, seleksi, paste tetap normal) ----------
  const mirrors = new Set();
  function mirror(input) {
    // field yang sudah di halaman diganti di tempat; field baru (tabel) dikembalikan terbungkus untuk di-append pemanggil
    const wrap = el('span', { className: `vwrap${input.tagName === 'TEXTAREA' ? ' area' : ''}` });
    const m = el('div', { className: 'mirror' });
    m.setAttribute('aria-hidden', 'true');
    if (input.parentNode) input.replaceWith(wrap);
    wrap.append(m, input);
    input.classList.add('mirrored');
    input._mirror = m;
    mirrors.add(input);
    input.addEventListener('input', () => { paint(input, m); complete(input); });
    input.addEventListener('scroll', () => { m.scrollTop = input.scrollTop; m.scrollLeft = input.scrollLeft; });
    input.addEventListener('mousemove', (e) => hoverAt(e, input));
    input.addEventListener('mouseleave', () => leaveToken());
    input.addEventListener('mousedown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = tokenAt(e);
      if (!t) return;
      e.preventDefault();
      post({ type: 'varGoto', name: t.dataset.name });
    });
    input.addEventListener('keydown', (e) => acKey(e, input));
    input.addEventListener('blur', () => setTimeout(closeAc, 150));
    requestAnimationFrame(() => paint(input, m)); // gaya terhitung baru ada setelah field masuk halaman
    return wrap;
  }
  function paint(input, m) {
    const cs = getComputedStyle(input);
    for (const p of ['font', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'textIndent', 'tabSize']) m.style[p] = cs[p];
    const segs = segments(input.value, vars, fileVars());
    m.replaceChildren(...segs.map((s) => {
      if (!s.name) return document.createTextNode(s.text);
      const t = el('span', { className: `tok t-${s.cls}`, textContent: s.text });
      t.dataset.name = s.name;
      return t;
    }), document.createTextNode(' ')); // spasi: baris kosong terakhir textarea tetap punya tinggi
    // input satu baris: teks lebih panjang dari field ikut bergeser sesuai scroll input
    m.scrollTop = input.scrollTop;
    m.scrollLeft = input.scrollLeft;
    input.parentNode?.classList.toggle('tokd', segs.some((s) => s.name));
  }
  function syncMirrors() {
    for (const input of mirrors) {
      if (!input.isConnected) { mirrors.delete(input); continue; }
      paint(input, input._mirror);
    }
  }

  // ---------- popup hover (300 ms, tetap saat mouse di popup, Esc menutup) + mode Ctrl ----------
  let hoverTok;
  let hoverTimer;
  let hideTimer;
  const pop = () => $('varPop');
  function tokenAt(e) {
    return document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList?.contains('tok'));
  }
  function hoverAt(e, input) {
    const t = tokenAt(e);
    document.querySelectorAll('.tok.link').forEach((x) => x !== t && x.classList.remove('link'));
    input.classList.toggle('linkable', !!t && (e.ctrlKey || e.metaKey));
    if (t && (e.ctrlKey || e.metaKey)) t.classList.add('link');
    if (t === hoverTok) return;
    hoverTok = t;
    clearTimeout(hoverTimer);
    if (!t) return leaveToken();
    clearTimeout(hideTimer);
    hoverTimer = setTimeout(() => post({ type: 'varHover', name: t.dataset.name }), 300);
  }
  function leaveToken() {
    clearTimeout(hoverTimer);
    hoverTok = undefined;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!pop().matches(':hover')) pop().hidden = true; }, 250);
  }
  function showHover(name, info) {
    const t = hoverTok;
    if (!t || t.dataset.name !== name) return;
    const p = pop();
    const rows = [];
    if (info.status.message) rows.push(el('div', { className: 'pmsg', textContent: info.status.message }));
    if (name.startsWith('$') && info.status.kind === 'dynamic') rows.push(el('div', {}, ['Dynamic variable, generated at send time. Example: ', el('code', { textContent: info.example || '' })]));
    if (info.script) rows.push(el('div', { textContent: 'Set by a script' }));
    if (info.file !== undefined) rows.push(el('div', {}, ['File variable: ', el('code', { textContent: info.file })]));
    const value = (env, v, secret) => {
      if (v === null) return el('i', { className: 'pnull', textContent: 'NULL' });
      if (!secret) return el('code', { textContent: v });
      const code = el('code', { textContent: '••••' });
      const show = el('button', { type: 'button', className: 'plink', textContent: 'Show', onclick: () => post({ type: 'showSecret', env, key: name }) });
      return el('span', {}, [code, ' ', show]);
    };
    for (const e of info.environments) {
      if (e.value === undefined) continue;
      rows.push(el('div', { className: e.active ? 'pactive' : '' }, [el('span', { className: 'penv', textContent: e.active ? `${e.name} (active)` : e.name }), value(e.name, e.value, e.secret)]));
    }
    if (info.globals) rows.push(el('div', {}, [el('span', { className: 'penv', textContent: 'Globals' }), value('', info.globals.value, info.globals.secret)]));
    const active = info.environments.find((e) => e.active);
    if (active) rows.push(el('div', { className: 'pfoot' }, [el('button', { type: 'button', className: 'plink', textContent: `Open in Environment "${active.name}"`, onclick: () => post({ type: 'varGoto', name }) })]));
    if (!rows.length) return;
    p.replaceChildren(...rows);
    const r = t.getBoundingClientRect();
    p.hidden = false;
    p.style.left = `${Math.max(4, Math.min(r.left, innerWidth - p.offsetWidth - 4))}px`;
    p.style.top = `${r.bottom + 4 + p.offsetHeight > innerHeight ? r.top - p.offsetHeight - 4 : r.bottom + 4}px`;
  }

  // ---------- autocomplete {{ ----------
  let ac = { input: undefined, items: [], i: 0, prefix: '' };
  function complete(input) {
    if (typeof input.selectionStart !== 'number') return;
    const before = input.value.slice(0, input.selectionStart);
    const prefix = completionPrefix(before);
    if (prefix === undefined) return closeAc();
    const names = [...new Set([...vars.names, ...fileVars()])].sort((a, b) => a.localeCompare(b)).concat(DYNAMIC);
    const items = names.filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase())).slice(0, 30);
    if (!items.length) return closeAc();
    ac = { input, items, i: 0, prefix };
    const box = $('acList');
    box.replaceChildren(...items.map((n, i) => el('div', { className: `aci t-${tokenClass(n, vars, fileVars())}${i === 0 ? ' on' : ''}`, textContent: n, onmousedown: (e) => { e.preventDefault(); ac.i = i; acceptAc(); } })));
    const r = input.getBoundingClientRect();
    box.hidden = false;
    box.style.left = `${r.left}px`;
    box.style.top = `${r.bottom + 2}px`;
  }
  function closeAc() { $('acList').hidden = true; ac.input = undefined; }
  function acceptAc() {
    const input = ac.input;
    if (!input) return;
    const pos = input.selectionStart;
    const name = ac.items[ac.i];
    const after = input.value.slice(pos);
    const start = pos - ac.prefix.length;
    input.value = input.value.slice(0, start) + name + (after.startsWith('}}') ? '' : '}}') + after;
    const caret = start + name.length + 2;
    input.setSelectionRange(caret, caret);
    closeAc();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function acKey(e, input) {
    if (ac.input !== input || $('acList').hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      ac.i = (ac.i + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length;
      [...$('acList').children].forEach((c, i) => c.classList.toggle('on', i === ac.i));
    } else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); acceptAc(); } else if (e.key === 'Escape') { e.stopPropagation(); closeAc(); }
  }

  function renderSettings() {
    $('redir').value = req.followRedirects ? 'yes' : 'no';
    $('tls').value = req.insecure ? 'ignore' : 'verify';
    $('tmo').value = req.timeoutSec === undefined ? '' : String(req.timeoutSec);
  }

  mirror($('url'));
  mirror($('bodyText'));
  $('varPop').addEventListener('mouseleave', () => leaveToken());
  document.addEventListener('keyup', (e) => { if (e.key === 'Control' || e.key === 'Meta') document.querySelectorAll('.tok.link, .linkable').forEach((x) => x.classList.remove('link', 'linkable')); });
  $('method').replaceChildren(...METHODS.map((m) => el('option', { value: m, textContent: m, className: `m-${m}` })));
  $('method').onchange = () => { req.method = $('method').value; renderMethod(); changed(); };
  $('url').oninput = () => { req.url = $('url').value; renderParams(); changed(); };
  // paste cURL mentah ke kolom URL: diimpor host (method, header, body, opsi)
  $('url').addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!/^\s*curl\s/i.test(text)) return;
    e.preventDefault();
    post({ type: 'pasteCurl', text });
  });
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
    $('send').title = running ? 'Cancel (Escape)' : 'Send (Ctrl+Enter)';
    $('ldCancel').disabled = false;
    $('ldCancel').textContent = 'Cancel';
    $('loading').hidden = !running;
    $('ldSub').textContent = running ? view.label : '';
    $('ldText').textContent = view?.kind === 'queued' ? view.position : 'Sending request';
    const res = view?.kind === 'response' ? view : undefined;
    $('st').textContent = res ? res.status : view?.kind === 'cancelled' ? 'Cancelled' : view?.kind === 'error' ? 'Error' : '';
    $('st').className = `status ${res ? res.statusClass : view?.kind === 'error' ? 'st-5' : 'st-1'}`;
    $('ms').textContent = res ? res.time : '';
    $('fmt').textContent = res ? res.format : '';
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
    if (e.key === 'Escape' && !$('varPop').hidden) { $('varPop').hidden = true; return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendNow(); }
    else if (e.key === 'Escape' && running) { e.preventDefault(); cancel(); }
  });
  $('redir').onchange = () => { req.followRedirects = $('redir').value === 'yes'; changed(); };
  $('tls').onchange = () => { req.insecure = $('tls').value === 'ignore'; changed(); };
  $('tmo').oninput = () => {
    const n = parseInt($('tmo').value, 10);
    req.timeoutSec = n > 0 ? n : undefined;
    changed();
  };
  $('openBody').onclick = () => post({ type: 'openBody' });
  $('openAsText').onclick = () => post({ type: 'openAsText' });
  $('saveBody').onclick = () => post({ type: 'saveBody' });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      req = m.req;
      renderRequest();
      $('multi').hidden = !(m.multi > 1);
      $('multiCount').textContent = `This file has ${m.multi} requests.`;
    }
    if (m.type === 'vars') { vars = { ok: m.ok, nulls: m.nulls, names: m.names }; syncMirrors(); }
    if (m.type === 'varHover') showHover(m.name, m.info);
    if (m.type === 'matching') $('matching').hidden = !m.on;
    if ('view' in m) renderView(m.view);
  });
  window.addEventListener('blur', flush);
  post({ type: 'ready' });
})();
