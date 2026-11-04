// All Environments: matriks variable × Environment (webview, JS vanilla). Fungsi murni diekspor ke Node untuk unit test.
(function () {
  /** sel per baris: NULL = value null atau secret belum di SecretStorage; undefined = key tidak ada di Environment itu */
  function matrix(keys, columns) {
    return keys.map((key) => {
      const cells = columns.map((c) => {
        const v = c.vars[key];
        if (!v) return { kind: 'absent' };
        if (v.secret) return { kind: v.set ? 'secret' : 'null', secret: true };
        return v.value === null ? { kind: 'null' } : { kind: 'value', value: v.value };
      });
      return { key, cells, hasNull: cells.some((c) => c.kind === 'null' || c.kind === 'absent') };
    });
  }
  const api = { matrix };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let st = { keys: [], columns: [] };
  const el = (tag, props, children) => { const e = Object.assign(document.createElement(tag), props || {}); for (const c of children || []) e.append(c); return e; };

  function render() {
    $('empty').hidden = st.columns.length > 0;
    $('head').replaceChildren(el('tr', {}, [el('th', { textContent: 'Variable' }), ...st.columns.map((c) => el('th', { className: c.name === st.active ? 'active' : '' }, [
      el('button', { type: 'button', textContent: c.name + (c.name === st.active ? ' (active)' : ''), title: `Open Environment "${c.name}"`, onclick: () => vscode.postMessage({ type: 'open', env: c.name }) }),
    ]))]));
    const rows = matrix(st.keys, st.columns).filter((r) => !$('nullOnly').checked || r.hasNull);
    $('rows').replaceChildren(...rows.map((r) => el('tr', { className: r.hasNull ? 'has-null' : '' }, [
      el('td', { className: 'k', textContent: r.key }),
      ...r.cells.map((c, i) => {
        const env = st.columns[i].name;
        if (c.kind === 'absent') return el('td', { className: 'null', textContent: 'missing', title: 'Key missing: use Sync' });
        const inp = el('input', { type: c.secret ? 'password' : 'text', value: c.kind === 'value' ? c.value : '', placeholder: c.kind === 'null' ? 'NULL' : c.secret ? '••••••••' : '', spellcheck: false });
        inp.onchange = () => vscode.postMessage({ type: 'set', env, key: r.key, value: inp.value });
        return el('td', { className: c.kind === 'null' ? 'null' : c.secret ? 'sec' : '' }, [inp]);
      }),
    ])));
  }
  $('nullOnly').onchange = render;
  window.addEventListener('message', (e) => { if (e.data.type === 'state') { st = e.data; if (!document.activeElement || document.activeElement.tagName !== 'INPUT' || document.activeElement.type === 'checkbox') render(); } });
  vscode.postMessage({ type: 'ready' });
})();
