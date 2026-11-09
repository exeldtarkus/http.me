// Dashboard: ringkasan Collections / Environments / Cookies (webview, JS vanilla, hanya baca + aksi cepat).
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
  const api = { segments };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, children) => { const e = Object.assign(document.createElement(tag), props || {}); for (const c of children || []) e.append(c); return e; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const send = (cmd, arg) => vscode.postMessage({ type: 'cmd', cmd, arg });
  const tile = (n, label, cls) => el('div', { className: `tile ${cls || ''}` }, [el('b', { textContent: String(n) }), el('span', { textContent: label })]);
  const bar = (methods, cls) => el('div', { className: cls }, segments(methods).map((s) => el('i', { className: s.method, style: `width:${s.pct}%`, title: `${s.method} ${s.n}` })));
  const btn = (text, onclick, extra) => el('button', { type: 'button', className: `btn ghost sm ${extra || ''}`, textContent: text, onclick });

  function collections(d) {
    $('cn').textContent = plural(d.collections.length, 'collection');
    const box = $('collections');
    if (!d.collections.length) return box.replaceChildren(el('p', { className: 'empty', textContent: 'No .http requests yet. Create one or import a Postman / OpenAPI file.' }));
    box.replaceChildren(
      el('div', { className: 'tiles' }, [tile(d.requests, 'requests'), tile(d.files, 'files'), tile(d.collections.length, 'collections')]),
      bar(d.methods, 'bar'),
      el('div', { className: 'legend' }, segments(d.methods).map((s) => el('span', { className: s.method, textContent: `${s.method} ${s.n}` }))),
      el('ul', {}, d.collections.map((c) => el('li', { className: 'row' }, [
        el('span', { className: 'name grow', textContent: c.name, title: c.name }),
        bar(c.methods, 'mini'),
        el('span', { className: 'meta', textContent: `${plural(c.requests, 'request')}${c.folders ? ` · ${plural(c.folders, 'folder')}` : ''}` }),
      ]))));
  }
  function environments(d) {
    $('en').textContent = plural(d.environments.length, 'Environment');
    const box = $('environments');
    if (!d.environments.length) return box.replaceChildren(el('p', { className: 'empty', textContent: 'No Environments yet. Create one to use variables in requests.' }));
    box.replaceChildren(
      el('div', { className: 'tiles' }, [tile(d.active || 'none', 'active'), tile(d.totalNulls, 'NULL values', d.totalNulls ? 'warn' : '')]),
      el('ul', {}, d.environments.map((e) => el('li', { className: 'row two' }, [
        el('span', { className: `dot${e.active ? ' on' : ''}`, title: e.active ? 'Active' : '' }),
        el('span', { className: 'name grow', textContent: e.name, title: e.name }),
        el('span', { className: 'meta', textContent: plural(e.variables, 'variable') }),
        e.nulls ? el('span', { className: 'pill warn', textContent: `${e.nulls} NULL` }) : el('span', { className: 'pill ok', textContent: 'complete' }),
        e.active ? el('span', { className: 'pill', textContent: 'active' }) : btn('Set active', () => send('setActive', e.name)),
        btn('Open', () => send('openEnvironment', e.name)),
      ]))));
  }
  function cookies(d) {
    $('kn').textContent = plural(d.total, 'cookie');
    const box = $('cookies');
    const rows = d.environments.filter((e) => e.cookies);
    if (!rows.length) return box.replaceChildren(el('p', { className: 'empty', textContent: 'No saved cookies. They appear after a request receives Set-Cookie.' }));
    box.replaceChildren(
      el('div', { className: 'tiles' }, [tile(d.total, 'cookies'), tile(rows.reduce((n, e) => n + e.domains, 0), 'domains'), tile(rows.reduce((n, e) => n + e.expired, 0), 'expired', rows.some((e) => e.expired) ? 'warn' : '')]),
      el('ul', {}, rows.map((e) => el('li', { className: 'row two' }, [
        el('span', { className: 'name grow', textContent: e.label }),
        el('span', { className: 'meta', textContent: `${plural(e.cookies, 'cookie')} · ${plural(e.domains, 'domain')}${e.session ? ` · ${e.session} session` : ''}` }),
        e.expired ? el('span', { className: 'pill warn', textContent: `${e.expired} expired` }) : '',
        btn('Delete all', () => send('clearCookies', e.env), 'danger'),
      ]))));
  }
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type !== 'data') return;
    $('sub').textContent = `${m.workspace} · updated ${new Date(m.at).toLocaleTimeString()}`;
    collections(m.collections); environments(m.environments); cookies(m.cookies);
  });
  $('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
  for (const b of document.querySelectorAll('[data-cmd]')) b.onclick = () => send(b.dataset.cmd);
  vscode.postMessage({ type: 'ready' });
})();
