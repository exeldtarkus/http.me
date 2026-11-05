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

  /** sisipkan teks di kursor (menggantikan seleksi): snippet & Tab = 2 spasi di editor script */
  function insertAt(text, start, end, ins) {
    return { text: text.slice(0, start) + ins + text.slice(end), caret: start + ins.length };
  }
  /** isi gutter nomor baris editor script */
  function lineNumbers(text) {
    return Array.from({ length: text.split('\n').length }, (_x, i) => String(i + 1)).join('\n');
  }

  /** tampilan loading response per state: tahap (pre-script / sending / redirect / post-script), sub-teks, Cancel / Cancelling… */
  function loadingState(view, cancelling) {
    const on = !!view && (view.kind === 'running' || view.kind === 'queued');
    return {
      hidden: !on,
      text: !on ? '' : view.kind === 'queued' ? view.position : view.stage || 'Sending request',
      sub: on ? view.label : '',
      cancel: cancelling ? 'Cancelling…' : 'Cancel',
      disabled: !!cancelling,
    };
  }

  /** loading sebaris (spinner 24 px) di bar response: request lain yang sedang berjalan */
  const othersText = (n) => (n > 0 ? `${n} other request${n === 1 ? '' : 's'} running` : '');

  /** tinggi area request saat batas di-drag: request min 80 px, response min 120 px */
  function clampSplit(h, total, minReq = 80, minRes = 120) {
    return Math.max(minReq, Math.min(h, total - minRes));
  }
  /** grid body per layout: single = tinggi area request (baris), two = lebar request (kolom); tanpa ukuran / panel = bawaan CSS */
  function layoutGrid(layout, size, total) {
    if (size === undefined || layout === 'panel') return { rows: '', cols: '' };
    if (layout === 'two') return { rows: '', cols: `${clampSplit(size, total, 240, 240)}px 5px minmax(240px, 1fr)` };
    return { rows: `auto auto ${clampSplit(size, total)}px 5px minmax(120px, 1fr)`, cols: '' };
  }

  /** item tab Scripts yang dibuka pertama: script pertama yang jalan (file ada / inline); belum ada script = This request (kosong) */
  function defaultScript(items) {
    return items.find((x) => x.exists && x.source !== 'own') || items.find((x) => x.source === 'own');
  }

  const JS_KEYWORDS = new Set(('const let var function return if else for while do break continue new await async try catch finally throw typeof instanceof '
    + 'in of class extends import export from default switch case delete void yield null undefined true false this').split(' '));
  const JS_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?|`(?:\\[\s\S]|[^`\\])*`?)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)(?=(\s*\()?)/g;
  const escHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  /** pewarnaan sintaks editor Scripts (lapisan di bawah textarea): komentar, string, angka, keyword, fungsi, httpme; teks di-escape */
  function highlightJs(code) {
    let out = '';
    let last = 0;
    for (const m of code.matchAll(JS_TOKEN)) {
      out += escHtml(code.slice(last, m.index));
      last = m.index + m[0].length;
      const cls = m[1] ? 'j-c' : m[2] ? 'j-s' : m[3] ? 'j-n'
        : JS_KEYWORDS.has(m[4]) ? 'j-k' : m[4] === 'httpme' ? 'j-h' : m[5] !== undefined ? 'j-f' : '';
      out += cls ? `<span class="${cls}">${escHtml(m[0])}</span>` : escHtml(m[0]);
    }
    return out + escHtml(code.slice(last));
  }

  /** cek sintaks body JSON / XML untuk garis merah di editor: { start, end, message } atau undefined bila valid / jenis lain */
  function bodyError(text, type) {
    if (!text.trim()) return undefined;
    const err = type === 'json' ? jsonError(text) : type === 'xml' ? xmlError(text) : undefined;
    if (!err) return undefined;
    let { start, end } = err;
    // akhir teks / spasi: tanda pindah ke karakter terakhir yang terlihat sebelumnya
    if (start >= text.length || /\s/.test(text[start])) {
      start = Math.min(start, text.length) - 1;
      while (start > 0 && /\s/.test(text[start])) start--;
      end = start + 1;
    }
    const before = text.slice(0, start).split('\n');
    return { start, end, message: `Line ${before.length}, column ${before[before.length - 1].length + 1}: ${err.message}` };
  }
  function jsonError(s) {
    let i = 0;
    const fail = (message, len) => { const w = /^[\w$]+/.exec(s.slice(i)); throw { start: i, end: i + (len || (w ? w[0].length : 1)), message }; };
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    const variable = () => { if (!s.startsWith('{{', i)) return false; const e = s.indexOf('}}', i + 2); if (e < 0) return false; i = e + 2; return true; };
    const str = () => {
      const from = i++;
      for (; i < s.length; i++) {
        if (s[i] === '\\') i++;
        else if (s[i] === '"') { i++; return; }
        else if (s[i] === '\n') break;
      }
      i = from;
      fail('Unterminated string', 1);
    };
    const list = (close, item, what) => {
      i++;
      ws();
      if (s[i] === close) { i++; return; }
      for (;;) {
        item();
        ws();
        if (s[i] === ',') {
          const comma = i++;
          ws();
          if (s[i] === close) { i = comma; fail('Trailing comma', 1); }
          continue;
        }
        if (s[i] === close) { i++; return; }
        fail(i >= s.length ? 'Unexpected end of JSON' : `Expected ',' or '${close}' after ${what}`);
      }
    };
    const value = () => {
      ws();
      const c = s[i];
      if (variable()) return;
      if (c === '{') return list('}', () => {
        ws();
        if (!variable()) {
          if (s[i] === '"') str();
          else fail(i >= s.length ? 'Unexpected end of JSON' : 'Expected a double-quoted property name');
        }
        ws();
        if (s[i] !== ':') fail(i >= s.length ? 'Unexpected end of JSON' : "Expected ':' after property name");
        i++;
        value();
      }, 'property value');
      if (c === '[') return list(']', value, 'array element');
      if (c === '"') return str();
      const num = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
      if (num) { i += num[0].length; return; }
      for (const w of ['true', 'false', 'null']) if (s.startsWith(w, i) && !/[\w$]/.test(s[i + w.length] || '')) { i += w.length; return; }
      fail(i >= s.length ? 'Unexpected end of JSON' : `Unexpected character '${c}'`);
    };
    try {
      value();
      ws();
      if (i < s.length) fail('Unexpected content after JSON');
      return undefined;
    } catch (e) {
      if (e && typeof e.start === 'number') return e; // posisi error sintaks body (bukan error program)
      throw e;
    }
  }
  function xmlError(s) {
    const stack = [];
    for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i)) {
      const skip = [['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?', '?>']].find(([a]) => s.startsWith(a, i));
      const close = skip ? s.indexOf(skip[1], i) : s.indexOf('>', i);
      if (close < 0) return { start: i, end: i + 1, message: "Unclosed '<'" };
      const end = close + (skip ? skip[1].length : 1);
      const tag = /^<(\/?)([\w:.-]+)/.exec(s.slice(i, end));
      if (!skip && tag && !s.startsWith('<!', i)) {
        if (tag[1]) {
          const open = stack.pop();
          if (!open) return { start: i, end, message: `Unexpected closing tag </${tag[2]}>` };
          if (open.name !== tag[2]) return { start: i, end, message: `Closing tag </${tag[2]}> does not match <${open.name}>` };
        } else if (!/\/\s*>$/.test(s.slice(i, end))) stack.push({ name: tag[2], start: i, end });
      }
      i = end;
    }
    const open = stack.pop();
    return open ? { start: open.start, end: open.end, message: `Tag <${open.name}> is not closed` } : undefined;
  }
  /** rentang warna JSON di body: k = key, s = string, n = angka, l = true/false/null; token variable di luar string dilewati */
  function jsonRanges(text) {
    const out = [];
    for (let i = 0; i < text.length;) {
      const c = text[i];
      if (c === '{' && text[i + 1] === '{') {
        const e = text.indexOf('}}', i + 2);
        if (e > 0) { i = e + 2; continue; }
      }
      if (c === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        const end = Math.min(text.length, text[j] === '"' ? j + 1 : j);
        out.push({ start: i, end, val: /^\s*:/.test(text.slice(end, end + 40)) ? 'k' : 's' });
        i = end;
        continue;
      }
      const m = /^(-?\d[\d.eE+-]*)|^(true|false|null)\b/.exec(text.slice(i, i + 40));
      if (m && !/[\w$]/.test(text[i - 1] || '')) { out.push({ start: i, end: i + m[0].length, val: m[1] ? 'n' : 'l' }); i += m[0].length; continue; }
      i++;
    }
    return out;
  }
  /** segmen mirror dipotong per rentang (urut, tidak tumpang tindih): potongan di dalam rentang mendapat prop = val; token variable tidak dipecah */
  function applyRanges(segs, ranges, prop) {
    const out = [];
    let pos = 0;
    let r = 0;
    for (const sg of segs) {
      const a = pos;
      const b = pos + sg.text.length;
      pos = b;
      if (sg.name) { out.push(sg); continue; }
      while (r < ranges.length && ranges[r].end <= a) r++;
      let i = a;
      let k = r;
      while (i < b) {
        const rg = ranges[k];
        if (!rg || rg.start >= b) { out.push({ ...sg, text: sg.text.slice(i - a) }); break; }
        if (rg.start > i) { out.push({ ...sg, text: sg.text.slice(i - a, rg.start - a) }); i = rg.start; }
        const e = Math.min(b, rg.end);
        out.push({ ...sg, text: sg.text.slice(i - a, e - a), [prop]: rg.val });
        i = e;
        if (rg.end <= b) k++;
      }
    }
    return out;
  }
  /** segmen mirror dipotong supaya rentang [start, end) bertanda err (garis merah) */
  const markSegments = (segs, start, end) => applyRanges(segs, [{ start, end, val: true }], 'err');
  /** Tab / Shift+Tab pada baris-baris seleksi: tambah / buang 2 spasi di awal tiap baris */
  function indentEdit(text, start, end, outdent) {
    const from = text.lastIndexOf('\n', start - 1) + 1;
    const nl = text.indexOf('\n', end > start && text[end - 1] === '\n' ? end - 1 : end);
    const to = nl < 0 ? text.length : nl;
    const lines = text.slice(from, to).split('\n');
    const cut = lines.map((l) => (outdent ? Math.min(2, /^ */.exec(l)[0].length) : -2));
    const insert = lines.map((l, i) => (outdent ? l.slice(cut[i]) : `  ${l}`)).join('\n');
    const delta = cut.reduce((n, c) => n - c, 0);
    return { from, to, insert, selStart: Math.max(from, start - cut[0]), selEnd: end + delta };
  }
  /** Enter: baris baru mengikuti indentasi baris kursor, +2 spasi setelah { atau [ */
  function enterIndent(text, caret) {
    const line = text.slice(text.lastIndexOf('\n', caret - 1) + 1, caret);
    return `\n${/^ */.exec(line)[0]}${/[{[]\s*$/.test(line) ? '  ' : ''}`;
  }

  /** HTML JSON rapi (host, satu baris per item) -> blok .f yang bisa dilipat; jumlah isi di data-n supaya Copy (textContent) tetap JSON asli */
  function foldJson(html) {
    const stack = [];
    const lines = html.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lead = /^ */.exec(line)[0];
      const rest = line.slice(lead.length);
      if (/^[}\]]/.test(rest) && stack.length) {
        const n = stack.pop();
        const unit = rest[0] === '}' ? (n === 1 ? 'key' : 'keys') : (n === 1 ? 'item' : 'items');
        lines[i] = `${lead}</span><span class="fs" data-n="${n} ${unit}"></span>${rest[0]}</span>${rest.slice(1)}`;
        continue;
      }
      if (stack.length) stack[stack.length - 1]++;
      if (/[{[]$/.test(rest)) { stack.push(0); lines[i] = `${lead}<span class="f"><i class="ft"></i>${rest}<span class="fi">`; }
    }
    return lines.join('\n');
  }
  /** kurung { } [ ] di kursor (sebelum lalu sesudah) + pasangannya; kurung di dalam string / variabel diabaikan */
  function bracketMatch(text, caret) {
    const pair = new Map();
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '{' && text[i + 1] === '{') { const e = text.indexOf('}}', i + 2); if (e > 0) { i = e + 1; continue; } }
      if (c === '"') { i++; while (i < text.length && text[i] !== '"' && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1; continue; }
      if (c === '{' || c === '[') stack.push(i);
      else if (c === '}' || c === ']') {
        const o = stack.pop();
        if (o !== undefined && (text[o] === '{') === (c === '}')) { pair.set(o, i); pair.set(i, o); }
      }
    }
    for (const at of [caret - 1, caret]) if (pair.has(at)) { const b = pair.get(at); return at < b ? [at, b] : [b, at]; }
    return undefined;
  }

  const api = { foldJson, bracketMatch, layoutGrid, bodyError, markSegments, jsonRanges, applyRanges, indentEdit, enterIndent, highlightJs, defaultScript, clampSplit, othersText, loadingState, METHODS, urlToParams, paramsToUrl, setBodyType, formToRows, rowsToForm, tokenClass, segments, completionPrefix, insertAt, lineNumbers };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  /** ikon tempat sampah untuk tombol hapus / lepas (bukan ✕) */
  const TRASH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.8 9.5h6.4l.8-9.5M6.6 7v4.5M9.4 7v4.5"/></svg>';
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
      // checkbox di luar urutan Tab: Tab dari Value → hapus → Key baris berikutnya (klik tetap bisa)
      const on = el('input', { type: 'checkbox', checked: row.enabled, title: 'Enabled (click to turn on / off)', tabIndex: -1 });
      const k = el('input', { type: 'text', value: row[keyName], placeholder: isNew ? 'Key' : '', spellcheck: false });
      const v = el('input', { type: 'text', value: row.value, placeholder: isNew ? 'Value' : '', spellcheck: false });
      const del = el('button', { className: 'del', type: 'button', title: 'Remove', innerHTML: TRASH });
      del.setAttribute('aria-label', 'Remove');
      tr.append(el('td', { className: 'c' }, [on]), el('td', {}, [mirror(k)]), el('td', {}, [mirror(v)]), el('td', { className: 'x' }, [del]));
      tbody.append(tr);
      const lockValue = () => { v.disabled = !row[keyName]; v.title = v.disabled ? 'Fill in the Key first' : ''; };
      lockValue();
      const live = () => {
        if (isNew) { isNew = false; rows.push(row); k.placeholder = ''; v.placeholder = ''; addRow({ [keyName]: '', value: '', enabled: true }, true); }
      };
      on.onchange = () => { live(); row.enabled = on.checked; tr.className = row.enabled ? '' : 'off'; onChange(false); };
      k.oninput = () => { live(); row[keyName] = k.value; lockValue(); onChange(false); };
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
    $('method').className = `mbtn m-${req.method}`;
    $('methodText').textContent = req.method;
    for (const b of $('methodMenu').children) b.setAttribute('aria-checked', String(b.dataset.m === req.method));
    $('bodyWarn').hidden = !(['GET', 'HEAD'].includes(req.method) && req.body !== '');
  }

  let formRows = [];
  function renderBody() {
    $('bodyFileNote').hidden = !req.bodyFile;
    $('bodyFileNote').textContent = req.bodyFile ? `The body is read from ${req.bodyFile} when the request is sent.` : '';
    for (const r of document.getElementsByName('bt')) r.checked = r.value === req.bodyType;
    const form = req.bodyType === 'form';
    $('beautify').hidden = !['json', 'xml'].includes(req.bodyType) || !!req.bodyFile;
    $('beautifyNote').hidden = true;
    $('bodyText').hidden = form || req.bodyType === 'none';
    // pembungkus mirror (flex: 1) ikut disembunyikan: tabel form langsung di bawah pilihan tipe body
    $('bodyText').closest('.vwrap').hidden = $('bodyText').hidden;
    $('bodyEd').hidden = $('bodyText').hidden;
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
    $('bodyEmpty').hidden = req.bodyType !== 'none' || !!req.bodyFile;
    $('bodyGutter').textContent = lineNumbers($('bodyText').value);
    paintBodyError();
  }
  /** garis merah + pesan di bawah editor Body bila JSON / XML tidak valid */
  function paintBodyError() {
    const t = $('bodyText');
    const err = !t.hidden && !req.bodyFile ? bodyError(t.value, req.bodyType) : undefined;
    $('bodyErr').hidden = !err;
    $('bodyErr').textContent = err ? err.message : '';
    t.closest('.vwrap').classList.toggle('bad', !!err);
    if (t._mirror) paint(t, t._mirror);
  }

  function renderRequest() {
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
    let segs = segments(input.value, vars, fileVars());
    const err = input.id === 'bodyText' && !$('bodyErr').hidden && req ? bodyError(input.value, req.bodyType) : undefined;
    // shortcut: warna JSON hanya untuk body <= 200 KB, lebih besar teks polos (mirror tiap ketikan)
    if (input.id === 'bodyText' && req && req.bodyType === 'json' && input.value.length <= 200000) segs = applyRanges(segs, jsonRanges(input.value), 'j');
    if (err) segs = markSegments(segs, err.start, err.end);
    // pasangan kurung di kursor (hanya saat body difokus)
    const bm = input.id === 'bodyText' && document.activeElement === input && input.value.length <= 200000 ? bracketMatch(input.value, input.selectionStart) : undefined;
    if (bm) segs = applyRanges(segs, bm.map((p) => ({ start: p, end: p + 1, val: true })), 'bm');
    m.replaceChildren(...segs.map((s) => {
      if (s.err || s.j || s.bm) return el('span', { className: `${s.err ? 'synerr ' : ''}${s.j ? `jx-${s.j} ` : ''}${s.bm ? 'jx-bm' : ''}`.trim(), textContent: s.text });
      if (!s.name) return document.createTextNode(s.text);
      const t = el('span', { className: `tok t-${s.cls}`, textContent: s.text });
      t.dataset.name = s.name;
      return t;
    }), document.createTextNode(' ')); // spasi: baris kosong terakhir textarea tetap punya tinggi
    // input satu baris: teks lebih panjang dari field ikut bergeser sesuai scroll input
    m.scrollTop = input.scrollTop;
    m.scrollLeft = input.scrollLeft;
    input.parentNode?.classList.toggle('tokd', segs.some((s) => s.name || s.err || s.j || s.bm));
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
    $('ckSend').value = req.noCookieJar || req.noSendCookies ? 'no' : 'yes';
    $('ckSave').value = req.noCookieJar || req.noSaveCookies ? 'no' : 'yes';
    $('redir').value = req.followRedirects ? 'yes' : 'no';
    $('tls').value = req.insecure ? 'ignore' : 'verify';
    $('tmo').value = req.timeoutSec === undefined ? '' : String(req.timeoutSec);
  }

  mirror($('url'));
  mirror($('bodyText'));
  document.addEventListener('selectionchange', () => { if (document.activeElement === $('bodyText')) paint($('bodyText'), $('bodyText')._mirror); });
  $('bodyText').addEventListener('blur', () => paint($('bodyText'), $('bodyText')._mirror));
  $('varPop').addEventListener('mouseleave', () => leaveToken());
  document.addEventListener('keyup', (e) => { if (e.key === 'Control' || e.key === 'Meta') document.querySelectorAll('.tok.link, .linkable').forEach((x) => x.classList.remove('link', 'linkable')); });
  // menu method custom: klik / Enter memilih, panah atas-bawah pindah item, Escape menutup
  const mItems = () => [...$('methodMenu').children];
  const closeMethodMenu = (focus) => { $('methodMenu').hidden = true; $('method').setAttribute('aria-expanded', 'false'); if (focus) $('method').focus(); };
  const openMethodMenu = () => {
    $('methodMenu').hidden = false;
    $('method').setAttribute('aria-expanded', 'true');
    (mItems().find((b) => b.dataset.m === req.method) || mItems()[0]).focus();
  };
  $('methodMenu').replaceChildren(...METHODS.map((m) => {
    const b = el('button', { type: 'button', role: 'menuitemradio', textContent: m, className: `m-${m}`, tabIndex: -1 });
    b.dataset.m = m;
    b.onclick = () => { closeMethodMenu(true); if (req.method !== m) { req.method = m; renderMethod(); changed(); } };
    return b;
  }));
  $('method').onclick = (e) => { e.stopPropagation(); $('methodMenu').hidden ? openMethodMenu() : closeMethodMenu(); };
  $('method').onkeydown = (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMethodMenu(); } };
  $('methodMenu').onkeydown = (e) => {
    const items = mItems(), i = items.indexOf(document.activeElement);
    const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (go !== undefined) { e.preventDefault(); items[(go + items.length) % items.length].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeMethodMenu(true); }
  };
  document.addEventListener('click', (e) => { if (!$('methodMenu').hidden && !e.target.closest('#methodMenu')) closeMethodMenu(); });
  $('url').oninput = () => { req.url = $('url').value; renderParams(); changed(); };
  // paste cURL mentah ke kolom URL: diimpor host (method, header, body, opsi)
  $('url').addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!/^\s*curl\s/i.test(text)) return;
    e.preventDefault();
    post({ type: 'pasteCurl', text });
  });
  $('bodyText').oninput = () => { req.body = $('bodyText').value; $('bodyGutter').textContent = lineNumbers(req.body); renderMethod(); paintBodyError(); changed(); };
  $('bodyText').addEventListener('scroll', () => { $('bodyGutter').scrollTop = $('bodyText').scrollTop; });
  // Tab = 2 spasi (banyak baris: indent / Shift+Tab outdent), Enter ikut indentasi; lewat insertText supaya Undo tetap jalan
  $('bodyText').addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return; // autocomplete {{ sudah menangani Tab / Enter
    const t = $('bodyText');
    const { selectionStart: a, selectionEnd: b, value: v } = t;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!e.shiftKey && !v.slice(a, b).includes('\n')) return void document.execCommand('insertText', false, '  ');
      const ed = indentEdit(v, a, b, e.shiftKey);
      t.setSelectionRange(ed.from, ed.to);
      if (ed.insert !== v.slice(ed.from, ed.to)) document.execCommand('insertText', false, ed.insert);
      t.setSelectionRange(ed.selStart, ed.selEnd);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertText', false, enterIndent(v, a));
    }
  });
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
  // body none: tombol + JSON / + Form / + Text = pilih tipe body itu
  for (const b of $('bodyEmpty').querySelectorAll('button')) {
    b.onclick = () => {
      const r = [...document.getElementsByName('bt')].find((x) => x.value === b.dataset.bt);
      r.checked = true;
      r.onchange();
      $('bodyText').focus();
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
  let cancelling = false; // Cancel diklik: tombol tetap "Cancelling…" sampai request benar-benar berhenti
  function renderView(view) {
    running = view?.kind === 'running' || view?.kind === 'queued';
    $('sendIdle').hidden = running;
    $('sendLabel').hidden = !running;
    $('send').setAttribute('aria-label', running ? 'Cancel request' : 'Send request');
    $('send').classList.toggle('busy', running);
    $('send').title = running ? 'Cancel (Escape)' : 'Send (Ctrl+Enter)';
    if (!running) cancelling = false;
    const ld = loadingState(view, cancelling);
    $('ldCancel').disabled = ld.disabled;
    $('ldCancel').textContent = ld.cancel;
    $('loading').hidden = ld.hidden;
    $('ldSub').textContent = ld.sub;
    $('ldText').textContent = ld.text;
    const res = view?.kind === 'response' ? view : undefined;
    $('st').textContent = res ? res.status : view?.kind === 'cancelled' ? 'Cancelled' : view?.kind === 'error' ? 'Error' : '';
    $('st').className = `status ${res ? res.statusClass : view?.kind === 'error' ? 'st-5' : 'st-1'}`;
    $('ms').textContent = res ? res.time : '';
    $('fmt').textContent = res ? res.format : '';
    $('sz').textContent = res ? res.size : '';
    $('resEmpty').hidden = !!view && !running;
    $('resBody').className = `code${view?.kind === 'error' ? ' error' : ''}`;
    const isJson = res?.format === 'JSON';
    $('resBody').classList.toggle('json', isJson);
    $('expandAll').hidden = $('collapseAll').hidden = !isJson;
    if (res) $('resBody').innerHTML = res.format === 'JSON' ? foldJson(res.bodyHtml) : res.bodyHtml; // sudah di-escape di host (response.ts)
    else $('resBody').textContent = view?.kind === 'error' ? view.message : view?.kind === 'cancelled' ? 'The request was cancelled.' : '';
    $('resHeaders').replaceChildren(...(res ? res.headers : []).map(([k, v]) => el('tr', {}, [el('td', { textContent: k }), el('td', { textContent: v })])));
    $('nResHeaders').textContent = res ? String(res.headers.length) : '';
    const cookies = res?.cookies ?? [];
    $('nResCookies').textContent = cookies.length ? String(cookies.length) : '';
    $('resCookies').replaceChildren(...cookies.map((c) => el('tr', {}, [el('td', { textContent: c.name }), el('td', { textContent: c.value }), el('td', { textContent: c.domain }),
      el('td', { textContent: c.path }), el('td', { textContent: c.session ? 'Session' : c.expires }), el('td', { textContent: [c.httpOnly ? 'HttpOnly' : '', c.secure ? 'Secure' : ''].filter(Boolean).join(' ') })])));
    $('resCookiesNote').textContent = res ? (cookies.length ? (req && (req.noCookieJar || req.noSaveCookies) ? 'Not saved: Save cookies from response is off for this request.' : 'Saved to the cookie jar of the active Environment.') : 'The response set no cookies.') : '';
    $('timeline').replaceChildren(...(res?.timeline ?? []).map((h, i, all) => el('li', {}, [
      el('b', { className: `status ${h.status >= 400 ? 'st-4' : h.status >= 300 ? 'st-3' : 'st-2'}`, textContent: String(h.status) }), ` ${i < all.length - 1 ? 'redirect from' : 'response'} ${h.url}`,
      ...(h.cookies.length ? [el('div', { className: 'ck', textContent: `Set-Cookie: ${h.cookies.join(', ')}` })] : []),
    ])));
    $('allow').hidden = !res?.allow;
    if (res?.allow) $('allow').replaceChildren(el('b', { textContent: 'Allowed methods' }), res.allow.length ? res.allow.join(', ') : 'none listed by the server');
    $('bodyNote').hidden = !res?.note;
    $('bodyNoteText').textContent = res?.note ?? '';
    $('openBody').hidden = !res?.canOpen;
    $('copyBody').hidden = !res || res.head || res.format === 'Binary';
    $('saveBody').hidden = !res?.canSave;
    $('resBodyTab').disabled = !!res?.head;
    renderTests(view);
    // pre-request gagal / skip: tab Tests langsung terlihat
    showResTab(res?.head ? 'rheaders' : view?.kind === 'error' && view.scripts ? 'rtests' : resTab);
  }

  function sendNow() {
    flush();
    post({ type: 'send', req });
  }
  function cancel() {
    cancelling = true;
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
  // @no-cookie-jar lama dipecah jadi dua opsi saat salah satunya diubah
  const cookieOpt = () => {
    req.noCookieJar = false;
    req.noSendCookies = $('ckSend').value === 'no';
    req.noSaveCookies = $('ckSave').value === 'no';
    changed();
  };
  $('ckSend').onchange = cookieOpt;
  $('ckSave').onchange = cookieOpt;
  $('tls').onchange = () => { req.insecure = $('tls').value === 'ignore'; changed(); };
  $('tmo').oninput = () => {
    const n = parseInt($('tmo').value, 10);
    req.timeoutSec = n > 0 ? n : undefined;
    changed();
  };
  $('others').onclick = () => post({ type: 'showRunning' });
  // Copy: teks body yang tampil; body > 1 MB diambil utuh dari file cache oleh host
  // lipatan JSON: klik panah / ringkasan = buka-tutup; Alt+klik = ikut semua turunannya
  $('resBody').onclick = (e) => {
    const f = e.target.closest('.ft, .fs')?.closest('.f');
    if (!f) return;
    const fold = !f.classList.contains('shut');
    for (const x of e.altKey ? [f, ...f.querySelectorAll('.f')] : [f]) x.classList.toggle('shut', fold);
  };
  $('expandAll').onclick = () => $('resBody').querySelectorAll('.f.shut').forEach((x) => x.classList.remove('shut'));
  $('collapseAll').onclick = () => $('resBody').querySelectorAll('.f .f').forEach((x) => x.classList.add('shut')); // akar tetap terbuka
  $('copyBody').onclick = () => post({ type: 'copyBody', text: $('resBody').textContent });
  $('openBody').onclick = () => post({ type: 'openBody' });
  // Save aktif bila .http atau script rantainya belum disimpan
  let docDirty = false;
  const paintSave = () => {
    const scriptDirty = !!scripts && !!scripts.available && [...scripts.pre, ...scripts.post].some((x) => x.dirty);
    $('save').disabled = !(docDirty || scriptDirty);
  };
  // Save: .http + script yang berubah; request untitled = dialog Save http.me
  $('save').onclick = () => { flush(); scFlush(); post({ type: 'save' }); };
  $('openAsText').onclick = () => post({ type: 'openAsText' });
  $('saveBody').onclick = () => post({ type: 'saveBody' });

  // ---- tab Scripts: Runs in order + editor script (isi = dokumen VS Code di host) ----
  let scripts; // state dari host (scriptsState)
  let scKind = 'pre';
  let scPath; // item yang sedang diedit ('' = inline, read-only)
  let scTimer;
  let dragFrom;
  const scItems = () => (scripts && scripts[scKind]) || [];
  function scFlush() {
    if (scTimer === undefined) return;
    clearTimeout(scTimer);
    scTimer = undefined;
    if (scPath) post({ type: 'scriptEdit', path: scPath, text: $('scText').value });
  }
  /** nomor baris + lapisan warna sintaks mengikuti isi textarea */
  function scPaint() {
    const t = $('scText');
    $('scGutter').textContent = lineNumbers(t.value);
    $('scHl').innerHTML = `${highlightJs(t.value)}\n`; // sudah di-escape; baris akhir ekstra = tinggi sama dengan textarea
    $('scHl').scrollTop = t.scrollTop;
    $('scHl').scrollLeft = t.scrollLeft;
  }
  function scEdited() {
    scPaint();
    clearTimeout(scTimer);
    scTimer = setTimeout(scFlush, 250);
  }
  function scSelect(item) {
    scFlush();
    scPath = item ? item.file : undefined;
    $('scFile').textContent = item ? (item.source === 'own' ? `This request · ${item.file.split(/[\\/]/).pop()}` : item.label) : '';
    $('scText').readOnly = !item || item.source === 'inline';
    $('scOpen').disabled = !item || item.source === 'inline';
    if (item && item.source === 'inline') { $('scText').value = item.code; scPaint(); }
    else if (item) post({ type: 'scriptLoad', path: item.file });
    renderChain();
  }
  function renderChain() {
    const list = scItems();
    const lines = list.filter((x) => x.source === 'line');
    $('scChain').replaceChildren(...list.map((x, i) => {
      const li = el('li', { className: `${x.file === scPath && x.source !== 'inline' ? 'on' : ''}${x.exists ? '' : ' missing'}`, title: x.exists ? x.label : `${x.label} (file not found)` });
      li.append(el('span', { className: 'ord', textContent: `${i + 1}.` }));
      const li2 = lines.indexOf(x);
      if (li2 >= 0) {
        li.draggable = true;
        li.ondragstart = () => { dragFrom = li2; };
        li.ondragover = (e) => e.preventDefault();
        li.ondrop = (e) => { e.preventDefault(); if (dragFrom !== undefined && dragFrom !== li2) post({ type: 'scriptMove', kind: scKind, from: dragFrom, to: li2 }); dragFrom = undefined; };
        li.append(el('span', { className: 'grip', textContent: '⠿' }));
      }
      li.append(el('button', { type: 'button', className: 'nm', textContent: `${x.label}${x.dirty ? ' ●' : ''}`, onclick: () => scSelect(x) }));
      if (li2 >= 0) {
        li.append(
          el('button', { type: 'button', className: 'mini', textContent: '◀', title: 'Run earlier', disabled: li2 === 0, onclick: () => post({ type: 'scriptMove', kind: scKind, from: li2, to: li2 - 1 }) }),
          el('button', { type: 'button', className: 'mini', textContent: '▶', title: 'Run later', disabled: li2 === lines.length - 1, onclick: () => post({ type: 'scriptMove', kind: scKind, from: li2, to: li2 + 1 }) }),
          el('button', { type: 'button', className: 'mini del-icon', innerHTML: TRASH, title: 'Remove from this request (the file is kept)', ariaLabel: 'Remove from this request', onclick: () => post({ type: 'scriptRemove', kind: scKind, path: x.file }) }),
        );
      }
      return li;
    }));
  }
  function renderScripts() {
    const ok = !!(scripts && scripts.available);
    $('scNone').hidden = ok;
    for (const id of ['scChainRow', 'scPreview', 'scTools']) $(id).hidden = !ok;
    $('scText').disabled = !ok;
    $('scriptsDot').hidden = !(ok && scripts.own);
    if (!ok) return;
    $('scPreview').textContent = scripts.preview.join('\n');
    $('scSnippets').replaceChildren(el('option', { value: '', textContent: 'Snippets…' }), ...scripts.snippets[scKind].map((x, i) => el('option', { value: String(i), textContent: x.title })));
    const items = scItems();
    const current = items.find((x) => (x.source === 'inline' ? scPath === '' : x.file === scPath));
    if (!current) scSelect(defaultScript(items));
    else renderChain();
  }
  for (const b of $('scKinds').querySelectorAll('button')) {
    b.onclick = () => {
      scFlush();
      scKind = b.dataset.k;
      for (const x of $('scKinds').querySelectorAll('button')) x.classList.toggle('on', x === b);
      scPath = undefined;
      renderScripts();
    };
  }
  $('scText').oninput = scEdited;
  $('scText').onscroll = () => {
    const t = $('scText');
    $('scGutter').scrollTop = t.scrollTop;
    $('scHl').scrollTop = t.scrollTop;
    $('scHl').scrollLeft = t.scrollLeft;
  };
  $('scText').onkeydown = (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !$('scText').readOnly) {
      e.preventDefault();
      const t = $('scText');
      const r = insertAt(t.value, t.selectionStart, t.selectionEnd, '  ');
      t.value = r.text;
      t.selectionStart = t.selectionEnd = r.caret;
      scEdited();
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); scFlush(); flush(); post({ type: 'scriptSave' }); }
  };
  $('scSnippets').onchange = () => {
    const sn = scripts && scripts.snippets[scKind][Number($('scSnippets').value)];
    $('scSnippets').value = '';
    const t = $('scText');
    if (!sn || t.readOnly) return;
    const r = insertAt(t.value, t.selectionStart, t.selectionEnd, sn.code);
    t.value = r.text;
    t.focus();
    t.selectionStart = t.selectionEnd = r.caret;
    scEdited();
  };
  $('scAdd').onclick = () => { scFlush(); post({ type: 'scriptAdd', kind: scKind }); };
  $('scOpen').onclick = () => { scFlush(); if (scPath) post({ type: 'scriptOpenEditor', path: scPath }); };
  $('scSave').onclick = () => { scFlush(); flush(); post({ type: 'scriptSave' }); };
  window.addEventListener('blur', scFlush);

  /** tab Tests & Console response: hasil script pre / post */
  function renderTests(view) {
    const sc = view && view.scripts;
    const tests = (sc && sc.tests) || [];
    const lines = (sc && sc.console) || [];
    const failed = tests.filter((t) => !t.passed).length;
    $('nTests').textContent = tests.length ? (failed ? `${tests.length - failed}/${tests.length}` : String(tests.length)) : (sc && sc.error ? '!' : '');
    $('nTests').className = `n${failed || (sc && sc.error) ? ' st-5' : tests.length ? ' st-2' : ''}`;
    $('testsErr').hidden = !(sc && sc.error);
    $('testsErr').textContent = (sc && sc.error) || '';
    $('tests').replaceChildren(...tests.map((t) => el('li', {}, [
      el('span', { className: t.passed ? 'pass' : 'fail', textContent: t.passed ? '✓ ' : '✗ ' }), t.name,
      ...(t.error ? [el('div', { className: 'why', textContent: t.error })] : []),
    ])));
    $('testsNone').hidden = tests.length > 0 || !!(sc && sc.error);
    $('nConsole').textContent = lines.length ? String(lines.length) : '';
    $('console').replaceChildren(...lines.map((l) => el('div', { className: l.level, textContent: l.text })));
    $('consoleNone').hidden = lines.length > 0;
  }

  // ---- layout response (single / two pane / panel bawah) + batas yang bisa di-drag; ukuran disimpan di state webview ----
  const SASH = 5;
  let layout = 'single';
  const two = () => layout === 'two';
  const sizeKey = () => (two() ? 'reqWidth' : 'reqHeight');
  const splitTotal = () => (two() ? window.innerWidth : window.innerHeight - $('reqPanes').getBoundingClientRect().top) - SASH;
  function applySplit(size) {
    const g = layoutGrid(layout, size, splitTotal());
    document.body.style.gridTemplateRows = g.rows;
    document.body.style.gridTemplateColumns = g.cols;
  }
  function saveSplit(size) { vscode.setState({ ...(vscode.getState() || {}), [sizeKey()]: size }); }
  const savedSplit = () => (vscode.getState() || {})[sizeKey()];
  function applyLayout(l) {
    layout = ['single', 'two', 'panel'].includes(l) ? l : 'single';
    // panel bawah (response saja) tidak ikut berubah bentuk; hanya tanda pilihan di menu
    if (!document.body.classList.contains('only-resp')) {
      document.body.classList.toggle('l-two', layout === 'two');
      document.body.classList.toggle('l-panel', layout === 'panel');
      $('sash').setAttribute('aria-orientation', two() ? 'vertical' : 'horizontal');
      applySplit(savedSplit());
    }
    for (const b of $('layoutMenu').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.l === layout));
  }
  const closeLayoutMenu = () => { $('layoutMenu').hidden = true; $('layoutBtn').setAttribute('aria-expanded', 'false'); };
  $('layoutBtn').onclick = (e) => {
    e.stopPropagation();
    $('layoutMenu').hidden = !$('layoutMenu').hidden;
    $('layoutBtn').setAttribute('aria-expanded', String(!$('layoutMenu').hidden));
  };
  for (const b of $('layoutMenu').querySelectorAll('button')) {
    b.onclick = () => { closeLayoutMenu(); applyLayout(b.dataset.l); post({ type: 'layout', layout: b.dataset.l }); };
  }
  document.addEventListener('click', (e) => { if (!$('layoutMenu').hidden && !e.target.closest('.layout')) closeLayoutMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('layoutMenu').hidden) closeLayoutMenu(); });
  applySplit(savedSplit());
  $('sash').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const sash = $('sash');
    sash.setPointerCapture(e.pointerId);
    sash.classList.add('drag');
    document.body.classList.add('resizing');
    const start = two() ? 0 : $('reqPanes').getBoundingClientRect().top;
    let size;
    const move = (ev) => { size = clampSplit((two() ? ev.clientX : ev.clientY) - start, splitTotal(), two() ? 240 : 80, two() ? 240 : 120); applySplit(size); };
    const up = () => {
      sash.classList.remove('drag');
      document.body.classList.remove('resizing');
      sash.removeEventListener('pointermove', move);
      if (size !== undefined) saveSplit(size);
    };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', up, { once: true });
    sash.addEventListener('pointercancel', up, { once: true });
  });
  $('sash').addEventListener('dblclick', () => { applySplit(undefined); saveSplit(undefined); });
  $('sash').addEventListener('keydown', (e) => {
    const keys = two() ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const r = $('reqPanes').getBoundingClientRect();
    const size = (two() ? r.width : r.height) + (e.key === keys[0] ? -20 : 20);
    applySplit(size);
    saveSplit(size);
  });
  window.addEventListener('resize', () => applySplit(savedSplit()));

  // ---- Beautify body JSON / XML (dirapikan di host: token variable tetap utuh, bisa Undo) ----
  function beautify() {
    if (!req || !['json', 'xml'].includes(req.bodyType)) return;
    flush();
    post({ type: 'beautify' });
  }
  $('beautify').onclick = beautify;
  $('bodyText').addEventListener('keydown', (e) => {
    if (e.key === 'F' && e.shiftKey && e.altKey) { e.preventDefault(); beautify(); }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') {
      docDirty = m.dirty;
      paintSave();
      req = m.req;
      renderRequest();
      $('multi').hidden = !(m.multi > 1);
      $('multiCount').textContent = `This file has ${m.multi} requests.`;
    }
    if (m.type === 'vars') { vars = { ok: m.ok, nulls: m.nulls, names: m.names }; syncMirrors(); }
    if (m.type === 'varHover') showHover(m.name, m.info);
    if (m.type === 'matching') $('matching').hidden = !m.on;
    if (m.type === 'reqCookies') {
      $('nCookies').textContent = m.list.length ? String(m.list.length) : '';
      $('reqCookies').replaceChildren(...m.list.map((c) => el('tr', {}, [el('td', { textContent: c.name }), el('td', { textContent: c.value, title: 'Masked' }), el('td', { textContent: c.domain }), el('td', { textContent: c.path })])));
      $('reqCookiesNote').textContent = m.off ? 'Send saved cookies is off for this request (Settings).' : m.list.length ? 'These saved cookies are sent with the request (values masked). Manage them in the Cookies view of the http.me sidebar.' : 'No saved cookie matches this URL yet. Cookies from responses are saved automatically.';
    }
    if (m.type === 'dirty') { docDirty = m.dirty; paintSave(); }
    if (m.type === 'scripts') { scripts = m; renderScripts(); paintSave(); }
    if (m.type === 'beautifyResult') { $('beautifyNote').hidden = !m.error; $('beautifyNote').textContent = m.error || ''; }
    if (m.type === 'others') { $('others').hidden = !m.n; $('othersText').textContent = othersText(m.n); }
    if (m.type === 'scriptSelect') { scripts && renderScripts(); const it = scItems().find((x) => x.file === m.path); if (it) scSelect(it); }
    if (m.type === 'scriptText' && m.path === scPath && m.text !== $('scText').value) {
      // dokumen script berubah (editor VS Code / Undo): isi editor panel ikut, posisi kursor dipertahankan sebisanya
      const t = $('scText');
      const at = t.selectionStart;
      t.value = m.text;
      t.selectionStart = t.selectionEnd = Math.min(at, m.text.length);
      scPaint();
    }
    if (m.type === 'mode') document.body.classList.toggle('only-resp', !!m.responseOnly);
    if (m.type === 'layout') applyLayout(m.layout);
    if ('view' in m) renderView(m.view);
  });
  window.addEventListener('blur', flush);
  post({ type: 'ready' });
  post({ type: 'scriptsGet' });
})();
