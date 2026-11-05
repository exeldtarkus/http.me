// panel request http.me (webview, JS vanilla). Fungsi murni di atas diekspor ke Node untuk unit test;
// UI hanya jalan di webview (acquireVsCodeApi ada). State request dipegang extension host, panel mengirim 'edit'.
(function () {
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'QUERY'];
  const authField = (name, label, kind = 'text', options = {}) => ({ name, label, kind, ...options });
  const AUTH_FORMS = [
    { type: 'inherit', label: 'Inherit from parent', description: 'Use the closest _auth.http file above this request.', fields: [] },
    { type: 'none', label: 'No Auth', description: 'Do not add authentication to this request.', fields: [] },
    { type: 'apiKey', label: 'API Key', description: 'Send a key in a request header or query parameter.', fields: [
      authField('key', 'Key name'), authField('value', 'Value', 'password', { secret: true }),
      authField('in', 'Add to', 'select', { options: [['header', 'Header'], ['query', 'Query Params']], default: 'header' }),
    ] },
    { type: 'basic', label: 'Basic Auth', description: 'Send a username and password using HTTP Basic authentication.', fields: [
      authField('username', 'Username'), authField('password', 'Password', 'password', { secret: true }),
    ] },
    { type: 'bearer', label: 'Bearer Token', description: 'Send a bearer token in the Authorization header.', fields: [
      authField('token', 'Token', 'password', { secret: true }),
    ] },
    { type: 'digest', label: 'Digest Auth', description: 'Configure HTTP Digest authentication.', fields: [
      authField('username', 'Username'), authField('password', 'Password', 'password', { secret: true }),
      authField('retry', 'Retry once after 401', 'checkbox', { placement: 'side', default: 'true' }),
      authField('algorithm', 'Algorithm', 'select', { advanced: true, options: [['MD5', 'MD5'], ['MD5-sess', 'MD5-sess'], ['SHA-256', 'SHA-256'], ['SHA-256-sess', 'SHA-256-sess'], ['SHA-512-256', 'SHA-512-256']] }),
      authField('qop', 'Quality of protection', 'select', { advanced: true, options: [['auth', 'auth'], ['auth-int', 'auth-int']] }),
      authField('realm', 'Realm', 'text', { advanced: true }), authField('nonce', 'Nonce', 'text', { advanced: true }),
      authField('nc', 'Nonce count', 'text', { advanced: true }), authField('cnonce', 'Client nonce', 'text', { advanced: true }),
      authField('opaque', 'Opaque', 'text', { advanced: true }),
    ] },
    { type: 'hawk', label: 'Hawk Authentication', description: 'Configure a Hawk message authentication code.', fields: [
      authField('id', 'ID'), authField('key', 'Key', 'password', { secret: true }),
      authField('algorithm', 'Algorithm', 'select', { options: [['sha256', 'SHA-256'], ['sha1', 'SHA-1']], default: 'sha256' }),
      authField('user', 'User', 'text', { advanced: true }), authField('nonce', 'Nonce', 'text', { advanced: true }),
      authField('ext', 'Extension', 'text', { advanced: true }), authField('app', 'Application', 'text', { advanced: true }),
      authField('dlg', 'Delegation', 'text', { advanced: true }), authField('timestamp', 'Timestamp', 'text', { advanced: true }),
    ] },
    { type: 'jwt', label: 'JWT Bearer', description: 'Configure a JWT bearer token.', fields: [
      authField('algorithm', 'Algorithm', 'select', { options: [['HS256', 'HS256'], ['HS384', 'HS384'], ['HS512', 'HS512'], ['RS256', 'RS256'], ['RS384', 'RS384'], ['RS512', 'RS512'], ['PS256', 'PS256'], ['ES256', 'ES256'], ['ES384', 'ES384']], default: 'HS256' }),
      authField('secret', 'Signing secret or private key', 'password', { secret: true }),
      authField('payload', 'Payload', 'textarea'), authField('header', 'Header JSON', 'textarea'),
      authField('add_to', 'Add token to', 'select', { options: [['header', 'Authorization header'], ['query', 'Query parameter']], default: 'header' }),
      authField('prefix', 'Header prefix', 'text', { default: 'Bearer' }),
      authField('secret_base64', 'Secret is Base64 encoded', 'checkbox', { placement: 'side', default: 'false' }),
    ] },
    { type: 'oauth1', label: 'OAuth 1.0', description: 'Configure OAuth 1.0 request credentials and signature options.', fields: [
      authField('consumer_key', 'Consumer key'), authField('consumer_secret', 'Consumer secret', 'password', { secret: true }),
      authField('token', 'Access token', 'password', { secret: true }), authField('token_secret', 'Token secret', 'password', { secret: true }),
      authField('signature_method', 'Signature method', 'select', { options: [['HMAC-SHA1', 'HMAC-SHA1'], ['HMAC-SHA256', 'HMAC-SHA256'], ['HMAC-SHA512', 'HMAC-SHA512'], ['RSA-SHA1', 'RSA-SHA1'], ['RSA-SHA256', 'RSA-SHA256'], ['PLAINTEXT', 'PLAINTEXT']], default: 'HMAC-SHA1' }),
      authField('add_to', 'Add credentials to', 'select', { options: [['header', 'Authorization header'], ['body', 'Body or URL']], default: 'header' }),
      authField('callback', 'Callback URL', 'text', { advanced: true }), authField('verifier', 'Verifier', 'text', { advanced: true }),
      authField('timestamp', 'Timestamp', 'text', { advanced: true }), authField('nonce', 'Nonce', 'text', { advanced: true }),
      authField('version', 'Version', 'text', { advanced: true }), authField('realm', 'Realm', 'text', { advanced: true }),
    ] },
    { type: 'oauth2', label: 'OAuth 2.0', description: 'Configure OAuth 2.0 grant and client settings.', fields: [
      authField('grant', 'Grant type', 'select', { options: [['client_credentials', 'Client Credentials'], ['password', 'Password'], ['authorization_code', 'Authorization Code + PKCE'], ['implicit', 'Implicit'], ['refresh_token', 'Refresh Token']], default: 'client_credentials' }),
      authField('token_url', 'Token URL'), authField('authorization_url', 'Authorization URL'),
      authField('client_id', 'Client ID'), authField('client_secret', 'Client secret', 'password', { secret: true }),
      authField('username', 'Username'), authField('password', 'Password', 'password', { secret: true }),
      authField('scope', 'Scopes'), authField('redirect_uri', 'Redirect URI', 'text', { advanced: true }),
      authField('code_verifier', 'PKCE code verifier', 'password', { advanced: true, secret: true }),
      authField('refresh_token', 'Refresh token', 'password', { advanced: true, secret: true }),
    ], actions: ['Get New Access Token', 'Clear'] },
    { type: 'aws', label: 'AWS Signature', description: 'Configure AWS Signature Version 4 credentials.', fields: [
      authField('access_key', 'Access key ID'), authField('secret_key', 'Secret access key', 'password', { secret: true }),
      authField('region', 'Region'), authField('service', 'Service'),
      authField('session_token', 'Session token', 'password', { secret: true }),
    ] },
  ];

  function authForm(type) {
    return AUTH_FORMS.find((x) => x.type === type) || AUTH_FORMS[0];
  }
  function switchAuthType(current, type) {
    const form = authForm(type);
    const allowed = new Set(form.fields.map((x) => x.name));
    const fields = Object.fromEntries(Object.entries((current && current.fields) || {})
      .filter(([name, value]) => allowed.has(name) && typeof value === 'string'));
    return { type: form.type, fields };
  }
  function isRawAuthSecret(type, name, value) {
    const field = authForm(type).fields.find((x) => x.name === name);
    return !!field?.secret && !!value && !/^\{\{\s*[^{}]+\s*\}\}$/.test(value.trim());
  }
  function authVariableName(type, name) {
    return `auth_${type.toLowerCase()}_${name}`;
  }
  function parseAuthForm(value, headers = []) {
    if (value) {
      let rest = value.trim();
      const first = /^(\S+)/.exec(rest);
      if (!first) return { type: 'inherit', fields: {} };
      rest = rest.slice(first[0].length).trimStart();
      const aliases = { apikey: 'apiKey', 'api-key': 'apiKey' };
      const type = aliases[first[1].toLowerCase()] || first[1];
      const form = AUTH_FORMS.find((x) => x.type === type);
      if (!form) return { type: 'inherit', fields: {} };
      const fields = {};
      while (rest) {
        const match = /^([a-z][a-z0-9_]*)=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+))/.exec(rest);
        if (!match) break;
        const raw = match[2] ?? match[3] ?? match[4];
        fields[match[1]] = raw.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\(["'\\])/g, '$1');
        rest = rest.slice(match[0].length).trimStart();
      }
      return { type: form.type, fields };
    }
    const auth = headers.find((x) => x.enabled && x.name.toLowerCase() === 'authorization');
    const bearer = auth && /^Bearer\s+(.+)$/i.exec(auth.value);
    return bearer ? { type: 'bearer', fields: { token: bearer[1] } } : { type: 'inherit', fields: {} };
  }

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

  /** pilih jenis body: Content-Type diatur (nilai user dipertahankan bila jenisnya sama); none = header & body dihapus.
   *  Mengembalikan body yang dibuang (none); stash = body itu, dipasang lagi saat kembali ke tipe lain dengan body kosong */
  function setBodyType(req, type, stash) {
    const isCt = (h) => h.name.toLowerCase() === 'content-type';
    const cur = req.headers.find((h) => h.enabled && isCt(h));
    req.headers = req.headers.filter((h) => !isCt(h) || (type !== 'none' && h === cur));
    req.bodyType = type;
    if (type === 'none') { const dropped = req.body; req.body = ''; return dropped; }
    if (req.body === '' && stash) req.body = stash;
    if (!cur) req.headers.push({ name: 'Content-Type', value: CONTENT_TYPES[type], enabled: true });
    else if (!FAMILY[type].test(cur.value)) cur.value = CONTENT_TYPES[type];
    return '';
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
    const first = s.search(/\S/);
    if (first >= 0 && s[first] !== '<' && !s.startsWith('{{', first)) return { start: first, end: first + 1, message: "The body is not XML: it must start with '<'" };
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
  /** rentang warna XML di body: p = tanda < </ > />, t = nama tag, a = nama atribut, s = nilai atribut, c = komentar / CDATA / <?xml?> */
  function xmlRanges(text) {
    const out = [];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
    for (const m of text.matchAll(re)) {
      const i = m.index;
      if (m[2] === undefined) { out.push({ start: i, end: i + m[0].length, val: 'c' }); continue; }
      const open = 1 + m[1].length;
      const attrsAt = i + open + m[2].length;
      out.push({ start: i, end: i + open, val: 'p' }, { start: i + open, end: attrsAt, val: 't' });
      for (const a of m[3].matchAll(/("[^"]*"|'[^']*')|[\w:.-]+/g)) out.push({ start: attrsAt + a.index, end: attrsAt + a.index + a[0].length, val: a[1] ? 's' : 'a' });
      out.push({ start: i + m[0].length - 1 - m[4].length, end: i + m[0].length, val: 'p' });
    }
    return out;
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

  /** HTML JSON rapi (host, satu baris per item) -> baris bergutter ala editor VS Code: nomor + panah lipat di kiri.
   *  Baris pembuka (.fo, data-end = baris penutup) membawa .fz = ringkasan (data-n) + penutupnya, tampil saat dilipat */
  function jsonRows(html) {
    const lines = html.split('\n');
    const ends = lines.map(() => -1);
    const counts = lines.map(() => 0);
    const stack = [];
    lines.forEach((line, i) => {
      const rest = line.trimStart();
      if (/^[}\]]/.test(rest) && stack.length) { ends[stack.pop()] = i; return; }
      if (stack.length) counts[stack[stack.length - 1]]++;
      if (/[{[]$/.test(rest)) stack.push(i);
    });
    return lines.map((line, i) => {
      const end = ends[i];
      let lc = line;
      if (end >= 0) {
        const close = lines[end].trimStart();
        const n = counts[i];
        lc += `<span class="fz" data-n="${n} ${close[0] === '}' ? (n === 1 ? 'key' : 'keys') : (n === 1 ? 'item' : 'items')}">${close}</span>`;
      }
      return `<div class="ln${end >= 0 ? ' fo' : ''}"${end >= 0 ? ` data-end="${end}"` : ''}><span class="gn">${i + 1}</span><span class="gf"></span><span class="lc">${lc}</span></div>`;
    }).join('');
  }
  /** tab yang tampil di strip (sisanya ke dropdown +N): urut dari kiri sampai ruang habis, tab aktif selalu tampil */
  function fitTabs(widths, avail, active, moreW) {
    const show = widths.map(() => false);
    if (widths.reduce((a, b) => a + b, 0) <= avail) return show.map(() => true);
    const budget = avail - moreW;
    let used = 0;
    for (let i = 0; i < widths.length && used + widths[i] <= budget; i++) { show[i] = true; used += widths[i]; }
    if (widths.length && !show[active]) {
      for (let i = widths.length - 1; i >= 0 && used + widths[active] > budget; i--) if (show[i]) { show[i] = false; used -= widths[i]; }
      show[active] = true;
    }
    return show;
  }
  /** baris yang tersembunyi: di dalam lipatan tertutup (ends[i] = baris penutup, -1 = bukan pembuka) */
  function hiddenRows(ends, shut) {
    let until = -1;
    return ends.map((end, i) => {
      if (i <= until) return true;
      if (shut[i] && end > i) until = end;
      return false;
    });
  }
  /** body: kurung pembuka di akhir baris yang pasangannya di baris lain = bisa dilipat; from = sesudah pembuka, to = posisi penutup */
  function foldRanges(text) {
    const out = [];
    const stack = [];
    let line = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\n') { line++; continue; }
      if (c === '{' && text[i + 1] === '{') { const e = text.indexOf('}}', i + 2); if (e > 0 && !text.slice(i, e).includes('\n')) { i = e + 1; continue; } }
      if (c === '"') { i++; while (i < text.length && text[i] !== '"' && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1; if (text[i] === '\n') line++; continue; }
      if (c === '{' || c === '[') stack.push({ i, line });
      else if ((c === '}' || c === ']') && stack.length) {
        const o = stack.pop();
        const eol = text.indexOf('\n', o.i);
        if (o.line < line && (text[o.i] === '{') === (c === '}') && !text.slice(o.i + 1, eol).trim()) out.push({ line: o.line, from: o.i + 1, to: i });
      }
    }
    return out.sort((x, y) => x.from - y.from);
  }
  /** teks editor -> teks asli: karakter penanda lipatan (Private Use) diganti isinya, bertingkat; penanda tak dikenal dibiarkan */
  const unfold = (text, hidden) => text.replace(/[-]/g, (c) => (hidden.has(c) ? unfold(hidden.get(c), hidden) : c));
  /** nomor baris asli tiap baris editor (baris di dalam lipatan ikut dihitung) */
  function realLines(text, hidden) {
    const out = [1];
    let n = 1;
    for (const c of text) {
      if (c === '\n') { n++; out.push(n); } else if (hidden.has(c)) n += (unfold(c, hidden).match(/\n/g) || []).length;
    }
    return out;
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

  const REASON = { 400: ['Bad Request', 'The server could not understand the request. Check the syntax, parameters and body.'], 401: ['Unauthorized', 'Authentication is required or has failed. Check your token or credentials.'],
    403: ['Forbidden', 'You are authenticated but not allowed to access this resource.'], 404: ['Not Found', 'The server cannot find the requested resource. Check the URL.'],
    405: ['Method Not Allowed', 'The resource does not support this HTTP method. See the Allow header.'], 408: ['Request Timeout', 'The server timed out waiting for the request.'],
    409: ['Conflict', 'The request conflicts with the current state of the resource.'], 410: ['Gone', 'The resource is no longer available.'], 413: ['Payload Too Large', 'The request body is larger than the server allows.'],
    415: ['Unsupported Media Type', 'The server does not accept this Content-Type.'], 418: ["I'm a teapot", 'The server refuses to brew coffee because it is a teapot.'], 422: ['Unprocessable Entity', 'The body is well-formed but failed validation.'],
    429: ['Too Many Requests', 'Rate limit reached. Wait a moment, then try again.'], 500: ['Internal Server Error', 'The server hit an unexpected error.'], 501: ['Not Implemented', 'The server does not support this functionality.'],
    502: ['Bad Gateway', 'A gateway or proxy received an invalid response from upstream.'], 503: ['Service Unavailable', 'The server is overloaded or down for maintenance.'], 504: ['Gateway Timeout', 'A gateway or proxy timed out waiting for upstream.'],
    204: ['No Content', 'The request succeeded and there is nothing to return.'], 304: ['Not Modified', 'The cached version is still valid.'] };
  const CLASS_HINT = { 4: 'The request was rejected by the server.', 5: 'The server failed to fulfil a valid request.' };
  const unesc = (h) => h.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  /** kartu di tengah tab Body: cancelled, error, response tanpa isi, atau 4xx/5xx dengan body teks singkat; selain itu undefined (body biasa) */
  function bodyNotice(view) {
    if (view?.kind === 'cancelled') return { title: 'The request was cancelled.', sub: 'Click Send to run it again.', cls: 'st-1' };
    if (view?.kind === 'error') return { title: 'Request failed', sub: view.message, cls: 'st-5' };
    if (view?.kind !== 'response' || view.head || view.format === 'Binary') return undefined;
    const m = /^(\d{3})\s*(.*)$/.exec(view.status);
    if (!m) return undefined;
    const code = Number(m[1]);
    const text = view.format === 'Text' ? unesc(view.bodyHtml).trim() : view.bodyHtml.trim();
    const failed = code >= 400;
    if (text && !(failed && view.format === 'Text' && text.length <= 200 && !text.includes('\n'))) return undefined;
    const known = REASON[code];
    const title = known?.[0] ?? (m[2] || 'Response');
    const sub = known?.[1] ?? (failed ? CLASS_HINT[code >= 500 ? 5 : 4] : 'The request completed with this status.');
    return { code: m[1], title, sub: text && !known ? CLASS_HINT[code >= 500 ? 5 : 4] : sub, cls: view.statusClass, ...(text ? { body: text } : { empty: 'Response body not found' }) };
  }

  /** posisi kecocokan teks biasa (bukan regex), tanpa beda huruf besar / kecil */
  function findMatches(text, query) {
    const out = [];
    if (!query) return out;
    const hay = text.toLowerCase(), needle = query.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push({ start: i, end: i + needle.length });
    return out;
  }

  const AUTO_LABEL = { basic: 'Basic', bearer: 'Bearer', digest: 'Digest', hawk: 'Hawk', jwt: 'JWT', oauth1: 'OAuth 1.0', oauth2: 'OAuth 2.0', aws: 'AWS Signature v4', apiKey: 'API Key' };
  /** header yang dibuat otomatis dari # @auth (ditampilkan `auto` di tab Headers); undefined = tidak ada */
  function autoAuthHeader(r) {
    if (!r.auth) return undefined;
    const form = parseAuthForm(r.auth, r.headers);
    const t = form.type, f = form.fields;
    const label = AUTO_LABEL[t];
    if (!label) return undefined;
    if (t === 'apiKey') return f.in === 'header' && f.key ? { name: f.key, text: `${label} (set in the Authorization tab)` } : undefined;
    if ((t === 'jwt' || t === 'oauth1') && (f.add_to === 'query' || f.add_to === 'body')) return undefined;
    return { name: 'Authorization', text: `${label} (set in the Authorization tab)` };
  }

  const api = { autoAuthHeader, findMatches, bodyNotice, fitTabs, xmlRanges, jsonRows, hiddenRows, foldRanges, unfold, realLines, bracketMatch, layoutGrid, bodyError, markSegments, jsonRanges, applyRanges, indentEdit, enterIndent, highlightJs, defaultScript, clampSplit, othersText, loadingState, METHODS, urlToParams, paramsToUrl, setBodyType, formToRows, rowsToForm, tokenClass, segments, completionPrefix, insertAt, lineNumbers, authForms: AUTH_FORMS, authForm, switchAuthType, isRawAuthSecret, authVariableName, parseAuthForm };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  let findHook; // diisi setelah bar cari siap: render ulang response menjalankan pencarian lagi
  /** ikon tempat sampah untuk tombol hapus / lepas (bukan ✕) */
  const TRASH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.8 9.5h6.4l.8-9.5M6.6 7v4.5M9.4 7v4.5"/></svg>';
  const $ = (id) => document.getElementById(id);
  /** request seperti ParsedRequest di httpFile.ts */
  let req;
  let editTimer;
  let authModel = { type: 'inherit', fields: {} };
  let authTimer;
  let authDirty = false;
  let authAdvancedOpen = false;
  let authSource;
  let authSourceIndex = -1;
  /** dari host: nama variable yang punya nilai / NULL di Environment aktif + Globals */
  let vars = { ok: [], nulls: [], names: [] };
  const fileVars = () => (req ? req.vars.map((v) => v.name) : []);

  const post = (msg) => vscode.postMessage(msg);
  /** kirim perubahan ke extension host (ditulis ke dokumen .http), digabung tiap 250 ms */
  function changed() {
    clearTimeout(editTimer);
    editTimer = setTimeout(() => post({ type: 'edit', req, index: activeBlock }), 250);
    counts();
    syncMirrors();
    askSnippet();
  }
  function flush() {
    if (editTimer === undefined) return;
    clearTimeout(editTimer);
    editTimer = undefined;
    post({ type: 'edit', req, index: activeBlock });
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
    const auto = autoAuthHeader(req);
    $('autoHeader').hidden = !auto;
    if (auto) { $('autoHeaderName').textContent = auto.name; $('autoHeaderText').textContent = auto.text; }
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
  /** lipatan body: karakter penanda (Private Use) -> teks yang dilipat; teks asli = unfold(nilai textarea) */
  const folds = new Map();
  let nextFold = 0xE000;
  /** gutter body: nomor baris asli + panah lipat (bisa dilipat / sedang dilipat) */
  function paintGutter() {
    const v = $('bodyText').value;
    const can = new Set(req && req.bodyType === 'json' && v.length <= 200000 ? foldRanges(v).map((r) => r.line) : []);
    $('bodyGutter').innerHTML = realLines(v, folds).map((n, i) => {
      const line = v.split('\n', i + 1)[i] || '';
      const shut = [...line].some((c) => folds.has(c));
      return `<div class="gl${shut ? ' shut' : can.has(i) ? ' can' : ''}" data-l="${i}">${n}</div>`;
    }).join('');
  }
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
    } else if (unfold($('bodyText').value, folds) !== req.body) $('bodyText').value = req.body; // body sama: lipatan tetap
    $('bodyEmpty').hidden = req.bodyType !== 'none' || !!req.bodyFile;
    paintGutter();
    paintBodyError();
  }
  /** garis merah + pesan di bawah editor Body bila JSON / XML tidak valid */
  function paintBodyError() {
    const t = $('bodyText');
    const err = !t.hidden && !req.bodyFile ? bodyError(unfold(t.value, folds), req.bodyType) : undefined;
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
    renderAuth();
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
    const marks = input.id === 'bodyText' ? [...input.value.matchAll(/[\uE000-\uF8FF]/g)].filter((x) => folds.has(x[0])) : [];
    // garis merah hanya tanpa lipatan (posisi error dihitung dari teks asli); pesan tetap tampil
    const err = input.id === 'bodyText' && !marks.length && !$('bodyErr').hidden && req ? bodyError(input.value, req.bodyType) : undefined;
    // shortcut: warna JSON / XML hanya untuk body <= 200 KB, lebih besar teks polos (mirror tiap ketikan)
    if (input.id === 'bodyText' && req && ['json', 'xml'].includes(req.bodyType) && input.value.length <= 200000) segs = applyRanges(segs, req.bodyType === 'xml' ? xmlRanges(input.value) : jsonRanges(input.value), 'j');
    if (err) segs = markSegments(segs, err.start, err.end);
    // pasangan kurung di kursor (hanya saat body difokus)
    const bm = input.id === 'bodyText' && document.activeElement === input && input.value.length <= 200000 ? bracketMatch(input.value, input.selectionStart) : undefined;
    if (bm) segs = applyRanges(segs, bm.map((p) => ({ start: p, end: p + 1, val: true })), 'bm');
    if (marks.length) segs = applyRanges(segs, marks.map((x) => ({ start: x.index, end: x.index + 1, val: true })), 'fold');
    m.replaceChildren(...segs.map((s) => {
      if (s.err || s.j || s.bm || s.fold) return el('span', { className: `${s.err ? 'synerr ' : ''}${s.j ? `jx-${s.j} ` : ''}${s.bm ? 'jx-bm ' : ''}${s.fold ? 'jx-fold' : ''}`.trim(), textContent: s.text });
      if (!s.name) return document.createTextNode(s.text);
      const t = el('span', { className: `tok t-${s.cls}`, textContent: s.text });
      t.dataset.name = s.name;
      return t;
    }), document.createTextNode(' ')); // spasi: baris kosong terakhir textarea tetap punya tinggi
    // input satu baris: teks lebih panjang dari field ikut bergeser sesuai scroll input
    m.scrollTop = input.scrollTop;
    m.scrollLeft = input.scrollLeft;
    input.parentNode?.classList.toggle('tokd', segs.some((s) => s.name || s.err || s.j || s.bm || s.fold));
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

  function authValue(field) {
    return authModel.fields[field.name] ?? field.default ?? (field.kind === 'checkbox' ? 'false' : '');
  }
  const authShown = new Set(); // field password yang sedang ditampilkan (bertahan saat form dirender ulang)
  const EYE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5c1 0 1.9.3 2.7.7M14.5 8S12 12.5 8 12.5c-1 0-1.9-.3-2.7-.7M2 2l12 12"/></svg>';
  /** input password + tombol mata (Show / Hide) di dalam kotak */
  function secretInput(field, control) {
    const btn = el('button', { type: 'button', className: 'auth-eye' });
    const paint = () => {
      const shown = authShown.has(field.name);
      control.type = shown ? 'text' : 'password';
      btn.innerHTML = shown ? EYE_OFF : EYE;
      btn.title = btn.ariaLabel = `${shown ? 'Hide' : 'Show'} ${field.label.toLowerCase()}`;
      btn.setAttribute('aria-pressed', String(shown));
    };
    btn.onclick = () => { if (authShown.has(field.name)) authShown.delete(field.name); else authShown.add(field.name); paint(); control.focus(); };
    paint();
    return el('div', { className: 'auth-secret' }, [control, btn]);
  }
  function renderAuthField(field) {
    const row = el('div', { className: 'row auth-row' });
    const id = `auth-${field.name}`;
    const label = el('label', { htmlFor: id, textContent: field.label });
    let control;
    if (field.kind === 'select') {
      control = el('select', { id });
      for (const [value, text] of field.options) control.append(el('option', { value, textContent: text }));
      const current = authValue(field);
      if (current && !field.options.some(([value]) => value === current)) control.append(el('option', { value: current, textContent: current }));
      control.value = current;
    } else if (field.kind === 'textarea') {
      control = el('textarea', { id, value: authValue(field), spellcheck: false });
    } else if (field.kind === 'checkbox') {
      control = el('input', { id, type: 'checkbox', checked: authValue(field) === 'true' });
    } else {
      control = el('input', { id, type: field.kind === 'password' ? 'password' : 'text', value: authValue(field), spellcheck: false });
    }
    const update = () => {
      authModel.fields[field.name] = field.kind === 'checkbox' ? String(control.checked) : control.value;
      const oldWarning = row.querySelector('.auth-warning');
      if (oldWarning) oldWarning.remove();
      if (isRawAuthSecret(authModel.type, field.name, authModel.fields[field.name])) row.append(authWarning(field));
      scheduleAuthChange();
    };
    control.oninput = update;
    control.onchange = update;
    if (field.kind === 'checkbox') { row.classList.add('auth-check'); row.append(control, label); } else row.append(label, field.kind === 'password' ? secretInput(field, control) : control); // kotak centang di depan labelnya
    if (isRawAuthSecret(authModel.type, field.name, authValue(field))) row.append(authWarning(field));
    return row;
  }
  function authWarning(field) {
    const warning = el('p', { className: 'note warn auth-warning' });
    warning.append(document.createTextNode('This secret is stored in this request file and will be committed.'));
    const move = el('button', { type: 'button', textContent: 'Move to secret variable' });
    move.onclick = () => {
      flushAuthChange();
      post({
        type: 'authMoveToSecret', index: activeBlock,
        auth: { type: authModel.type, fields: { ...authModel.fields } },
        field: field.name, name: authVariableName(authModel.type, field.name),
      });
    };
    warning.append(move);
    return warning;
  }
  function scheduleAuthChange() {
    authDirty = true;
    clearTimeout(authTimer);
    authTimer = setTimeout(flushAuthChange, 250);
  }
  function flushAuthChange() {
    if (!authDirty) return;
    clearTimeout(authTimer);
    authTimer = undefined;
    post({ type: 'authChange', index: activeBlock, auth: { type: authModel.type, fields: { ...authModel.fields } } });
  }
  function renderAuth() {
    if (!authDirty) authModel = parseAuthForm(req.auth, req.headers);
    const form = authForm(authModel.type);
    $('authType').value = form.type;
    $('authDescription').textContent = form.description;
    $('authSource').hidden = form.type !== 'inherit';
    $('authSource').textContent = authSource ? `Inherited from ${authSource}.` : 'No parent _auth.http file was found.';
    if (form.type === 'inherit' && authSourceIndex !== activeBlock) {
      authSourceIndex = activeBlock;
      post({ type: 'authSourceGet', index: activeBlock });
    }
    const side = form.fields.filter((x) => x.placement === 'side');
    const main = form.fields.filter((x) => !x.placement && !x.advanced);
    const advanced = form.fields.filter((x) => x.advanced);
    $('authOptions').replaceChildren(...side.map(renderAuthField));
    $('authOptions').hidden = !side.length;
    $('authFields').replaceChildren(...main.map(renderAuthField));
    $('authFields').hidden = !main.length;
    $('authAdvancedFields').replaceChildren(...advanced.map(renderAuthField));
    $('authAdvanced').hidden = !advanced.length;
    $('authAdvanced').open = authAdvancedOpen;
    $('authActions').replaceChildren(...(form.actions || []).map((text) => el('button', {
      type: 'button', className: 'btn ghost sm', textContent: text,
      title: text === 'Clear' ? 'Forget the stored access token' : 'Sign in (if needed) and store a new access token',
      onclick: () => { flush(); $('authNotice').textContent = ''; post({ type: text === 'Clear' ? 'oauth2Clear' : 'oauth2Token', index: activeBlock }); },
    })));
    $('authActions').hidden = !(form.actions || []).length;
  }
  for (const form of AUTH_FORMS) $('authType').append(el('option', { value: form.type, textContent: form.label }));
  $('authType').onchange = () => {
    authModel = switchAuthType(authModel, $('authType').value);
    authAdvancedOpen = false;
    authSource = undefined;
    authSourceIndex = -1;
    $('authNotice').textContent = '';
    authDirty = true;
    renderAuth();
    flushAuthChange();
  };
  $('authAdvanced').addEventListener('toggle', () => { authAdvancedOpen = $('authAdvanced').open; });

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
    if (!/^\s*(curl|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|\$session)\b/i.test(text)) return;
    e.preventDefault();
    post({ type: 'pasteCurl', text });
  });
  $('bodyText').oninput = () => {
    const full = unfold($('bodyText').value, folds);
    paintGutter();
    if (full === req.body) return paintBodyError(); // hanya lipat / buka lipatan
    req.body = full;
    renderMethod();
    paintBodyError();
    changed();
  };
  // gutter body: klik panah = lipat / buka lipatan baris itu (lewat insertText supaya Undo tetap jalan)
  $('bodyGutter').addEventListener('mousedown', (e) => {
    const g = e.target.closest('.gl.can, .gl.shut');
    if (!g) return;
    e.preventDefault();
    const t = $('bodyText');
    const v = t.value;
    const line = +g.dataset.l;
    let start = 0;
    for (let i = 0; i < line; i++) start = v.indexOf('\n', start) + 1;
    const eol = v.indexOf('\n', start) < 0 ? v.length : v.indexOf('\n', start);
    t.focus();
    if (g.classList.contains('shut')) {
      for (let k = eol - 1; k >= start; k--) if (folds.has(v[k])) { t.setSelectionRange(k, k + 1); document.execCommand('insertText', false, folds.get(v[k])); }
    } else {
      const r = foldRanges(v).find((x) => x.line === line);
      if (!r) return;
      const mark = String.fromCharCode(nextFold++);
      folds.set(mark, v.slice(r.from, r.to));
      t.setSelectionRange(r.from, r.to);
      document.execCommand('insertText', false, mark);
    }
    t.setSelectionRange(eol, eol);
  });
  // Copy / Cut dari body yang terlipat: isi lipatan ikut tersalin
  for (const type of ['copy', 'cut']) {
    $('bodyText').addEventListener(type, (e) => {
      const t = $('bodyText');
      const sel = t.value.slice(t.selectionStart, t.selectionEnd);
      if (!/[\uE000-\uF8FF]/.test(sel)) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', unfold(sel, folds));
      if (type === 'cut') document.execCommand('delete');
    });
  }
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
  let bodyStash = '';
  for (const r of document.getElementsByName('bt')) {
    r.onchange = () => {
      // text -> form: body lama yang bukan key=value tetap utuh di .http sampai tabel form diedit
      // none -> tipe lain: body sebelum none dipasang lagi
      const dropped = setBodyType(req, r.value, bodyStash);
      bodyStash = r.value === 'none' ? dropped || bodyStash : '';
      const xmlErr = r.value === 'xml' && !req.bodyFile ? bodyError(req.body, 'xml') : undefined;
      if (xmlErr) post({ type: 'warn', message: `The body is not valid XML (${xmlErr.message}). Fix the body or choose another body type.` });
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
    // file multi-request: tab yang belum pernah dikirim punya pesan sendiri
    document.querySelector('#resEmpty p').textContent = blocks.length > 1 ? 'This request has not been sent yet. Click Send or Send All.' : 'Enter the URL and click Send to get a response';
    const notice = bodyNotice(view);
    $('resNotice').hidden = !notice;
    $('resBody').hidden = !!notice;
    if (notice) {
      $('resNotice').className = `notice ${notice.cls}`;
      $('noticeCode').textContent = notice.code ?? '';
      $('noticeTitle').textContent = notice.title;
      $('noticeSub').textContent = notice.sub;
      $('noticeBody').hidden = !notice.body && !notice.empty;
      $('noticeBody').classList.toggle('none', !notice.body);
      $('noticeBody').textContent = notice.body ?? notice.empty ?? '';
    }
    $('resBody').className = 'code';
    const isJson = res?.format === 'JSON';
    resText = undefined;
    $('resBody').classList.toggle('json', isJson);
    $('expandAll').hidden = $('collapseAll').hidden = !isJson;
    if (res) $('resBody').innerHTML = isJson ? jsonRows(res.bodyHtml) : res.bodyHtml; // sudah di-escape di host (response.ts)
    if (isJson) {
      resText = el('pre', { innerHTML: res.bodyHtml }).textContent; // Copy = JSON asli, tanpa nomor baris / ringkasan lipatan
      $('resBody').style.setProperty('--gw', `${String($('resBody').children.length).length}ch`);
    }
    else if (!res) $('resBody').textContent = ''; // bukan response: kosongkan (non-JSON jangan dihapus)
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
    $('copyBody').hidden = $('findBody').hidden = !res || res.head || res.format === 'Binary';
    findHook?.();
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
  // lipatan JSON: klik panah / nomor / ringkasan = buka-tutup; Alt+klik = ikut semua turunannya
  let resText;
  const resRows = () => [...$('resBody').children];
  function refreshRows() {
    const rows = resRows();
    const hid = hiddenRows(rows.map((r) => (r.classList.contains('fo') ? +r.dataset.end : -1)), rows.map((r) => r.classList.contains('shut')));
    rows.forEach((r, i) => { r.hidden = hid[i]; });
  }
  $('resBody').onclick = (e) => {
    const row = e.target.closest('.gn, .gf, .fz')?.closest('.ln.fo');
    if (!row) return;
    const rows = resRows();
    const i = rows.indexOf(row);
    const fold = !row.classList.contains('shut');
    for (const r of e.altKey ? rows.slice(i, +row.dataset.end + 1) : [row]) if (r.classList.contains('fo')) r.classList.toggle('shut', fold);
    refreshRows();
  };
  $('expandAll').onclick = () => { resRows().forEach((r) => r.classList.remove('shut')); refreshRows(); };
  $('collapseAll').onclick = () => { resRows().slice(1).forEach((r) => r.classList.toggle('shut', r.classList.contains('fo'))); refreshRows(); }; // akar tetap terbuka
  // Code snippet (panel kanan): host membuat teksnya (variable, secret, cookie), webview hanya meminta dan menampilkan
  const snippetOpts = () => ({ language: $('cpLang').value, ...Object.fromEntries([...document.querySelectorAll('#cpOpts input[data-o]')].map((i) => [i.dataset.o, i.checked])) });
  let snippetTimer;
  function askSnippet() {
    if ($('codePanel').hidden) return;
    clearTimeout(snippetTimer);
    snippetTimer = setTimeout(() => post({ type: 'snippet', req, opts: snippetOpts() }), 150);
  }
  const toggleCode = (on = $('codePanel').hidden, focusBtn = true) => {
    $('codePanel').hidden = !on;
    $('codeBtn').setAttribute('aria-expanded', String(on));
    if (on) askSnippet(); else if (focusBtn) $('codeBtn').focus(); // klik di luar: fokus tetap di tempat yang diklik
  };
  $('codeBtn').onclick = () => toggleCode();
  $('cpClose').onclick = () => toggleCode(false);
  $('cpLang').onchange = askSnippet;
  $('cpOpts').onchange = askSnippet;
  $('cpWrap').onchange = () => $('cpText').classList.toggle('wrap', $('cpWrap').checked);
  $('cpCopy').onclick = () => post({ type: 'copySnippet', req, opts: snippetOpts() });
  $('codePanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); toggleCode(false); } });
  // klik di luar panel (dan di luar tombolnya) menutup panel; tombol </> sendiri yang mengatur buka / tutup
  document.addEventListener('mousedown', (e) => { if (!$('codePanel').hidden && !e.target.closest('#codePanel, #codeBtn')) toggleCode(false, false); }, true);
  document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'c') { e.preventDefault(); toggleCode(); } });
  // cari di body: sorot lewat CSS Custom Highlight (DOM body tidak diubah, lipatan JSON tetap utuh)
  let found = [], foundAt = 0;
  const paintFind = (jump) => {
    $('findCount').textContent = found.length ? `${foundAt + 1} / ${found.length}` : ($('findInput').value ? 'No results' : '');
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    CSS.highlights.set('httpme-find', new Highlight(...found));
    CSS.highlights.set('httpme-find-current', new Highlight(...(found[foundAt] ? [found[foundAt]] : [])));
    if (jump && found[foundAt]) found[foundAt].startContainer.parentElement?.scrollIntoView({ block: 'center' });
  };
  const runFind = () => {
    found = []; foundAt = 0;
    const q = $('findInput').value;
    const nodes = [];
    const walk = document.createTreeWalker($('resBody'), NodeFilter.SHOW_TEXT);
    let full = '';
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (!n.parentElement.closest('.ln[hidden], .fz, .gn, .gf')) { nodes.push([full.length, n]); full += n.data; }
    for (const m of findMatches(full, q)) {
      const a = [...nodes].reverse().find(([o]) => o <= m.start), z = [...nodes].reverse().find(([o]) => o < m.end);
      if (!a || !z) continue;
      const r = document.createRange();
      r.setStart(a[1], m.start - a[0]); r.setEnd(z[1], m.end - z[0]);
      found.push(r);
    }
    paintFind(true);
  };
  const stepFind = (d) => { if (found.length) { foundAt = (foundAt + d + found.length) % found.length; paintFind(true); } };
  findHook = () => { if (!$('findBar').hidden) runFind(); };
  const openFind = () => { $('findBar').hidden = false; $('findInput').focus(); $('findInput').select(); runFind(); };
  const closeFind = () => { $('findBar').hidden = true; found = []; paintFind(false); };
  $('findBody').onclick = () => ($('findBar').hidden ? openFind() : closeFind());
  $('findInput').oninput = runFind;
  $('findInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.stopPropagation(); closeFind(); } };
  $('findPrev').onclick = () => stepFind(-1);
  $('findNext').onclick = () => stepFind(1);
  $('findClose').onclick = closeFind;
  $('r-rbody').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !$('resBody').hidden) { e.preventDefault(); openFind(); } });
  $('copyBody').onclick = () => post({ type: 'copyBody', text: resText ?? $('resBody').textContent });
  $('openBody').onclick = () => post({ type: 'openBody' });
  // Save aktif bila .http atau script rantainya belum disimpan
  let docDirty = false;
  const paintSave = () => {
    const scriptDirty = !!scripts && !!scripts.available && [...scripts.pre, ...scripts.post].some((x) => x.dirty);
    $('save').disabled = !(docDirty || scriptDirty);
  };
  // Save: .http + script yang berubah; request untitled = dialog Save http.me
  $('save').onclick = () => { flush(); scFlush(); post({ type: 'save' }); };
  // ---- file multi-request: tab request / response (sama-sama memilih blok aktif) + Send All ----
  let blocks = [];
  let activeBlock = 0;
  let allRunning = false;
  function renderBlocks(list, active) {
    if (active !== activeBlock) bodyStash = ''; // body simpanan "none" milik blok lain
    blocks = list;
    activeBlock = active;
    $('reqBlocks').hidden = blocks.length < 2;
    $('resBlocks').hidden = blocks.length < 2;
    document.querySelector('.resp').classList.toggle('multi', blocks.length >= 2);
    renderStrip($('rbTabs'));
    renderStrip($('resBlocks'));
    allRunning = blocks.some((b) => b.cls === 'run');
    $('sendAll').textContent = allRunning ? 'Cancel All' : 'Send All';
    $('sendAll').classList.toggle('busy', allRunning);
  }
  $('openText').onclick = () => { flush(); post({ type: 'openAsText' }); };
  $('sendAll').onclick = () => { flush(); post({ type: allRunning ? 'cancelAll' : 'sendAll' }); };
  const pickTab = (i) => { if (i === activeBlock) return; flush(); post({ type: 'pickBlock', index: i }); };
  const tabParts = (b) => [el('span', { className: `rb-m m-${b.method}`, textContent: b.method }), el('span', { className: 'rb-l', textContent: b.label }), el('span', { className: `rb-s ${b.cls}`, textContent: b.text })];
  /** strip tab request / response: tab yang muat + tombol +N (dropdown sisa tab); dihitung ulang saat lebar berubah */
  function renderStrip(box) {
    const tabs = blocks.map((b, i) => {
      const t = el('button', { type: 'button', className: i === activeBlock ? 'on' : '', title: `${b.method} · ${b.label}` }, tabParts(b));
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(i === activeBlock));
      t.onclick = () => pickTab(i);
      return t;
    });
    const more = el('button', { type: 'button', className: 'rb-more' });
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    box.replaceChildren(...tabs, more);
    box._fit = () => {
      tabs.forEach((t) => { t.hidden = false; });
      more.hidden = false;
      more.textContent = `+${tabs.length}`;
      const show = fitTabs(tabs.map((t) => t.offsetWidth + 2), box.clientWidth, activeBlock, more.offsetWidth + 6);
      const rest = show.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
      tabs.forEach((t, i) => { t.hidden = !show[i]; });
      more.hidden = !rest.length;
      more.textContent = `+${rest.length}`;
      more.title = `${rest.length} more request${rest.length === 1 ? '' : 's'}`;
      more.onclick = (e) => { e.stopPropagation(); if (stripMenu.hidden || menuBtn !== more) openStripMenu(more, rest); else closeStripMenu(); };
    };
    box._fit();
  }
  for (const box of [$('rbTabs'), $('resBlocks')]) new ResizeObserver(() => box._fit && box._fit()).observe(box);
  // dropdown sisa tab: filter bila > 8, panah atas / bawah, Enter memilih, Escape menutup
  const stripMenu = el('div', { className: 'rb-menu', hidden: true });
  stripMenu.setAttribute('role', 'menu');
  document.body.append(stripMenu);
  let menuBtn;
  function closeStripMenu(focus) {
    stripMenu.hidden = true;
    menuBtn?.setAttribute('aria-expanded', 'false');
    if (focus) menuBtn?.focus();
  }
  function openStripMenu(btn, rest) {
    menuBtn = btn;
    const items = rest.map((i) => {
      const b = el('button', { type: 'button', className: i === activeBlock ? 'on' : '', tabIndex: -1 }, tabParts(blocks[i]));
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(i === activeBlock));
      b.onclick = () => { closeStripMenu(); pickTab(i); };
      return b;
    });
    const filter = rest.length > 8 ? el('input', { type: 'search', className: 'rb-filter', placeholder: 'Filter requests', spellcheck: false }) : undefined;
    if (filter) {
      filter.setAttribute('aria-label', 'Filter requests');
      filter.oninput = () => { const q = filter.value.toLowerCase(); items.forEach((b) => { b.hidden = !b.textContent.toLowerCase().includes(q); }); };
    }
    stripMenu.replaceChildren(...(filter ? [filter] : []), el('div', { className: 'rb-list' }, items));
    stripMenu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const up = below < 160 && r.top > below; // dekat bawah layar: buka ke atas
    stripMenu.style.maxHeight = `${Math.max(120, up ? r.top - 12 : below)}px`;
    const w = stripMenu.offsetWidth;
    stripMenu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    stripMenu.style.top = `${up ? r.top - 4 - stripMenu.offsetHeight : r.bottom + 4}px`;
    (filter || items.find((b) => b.classList.contains('on')) || items[0]).focus();
  }
  stripMenu.addEventListener('keydown', (e) => {
    const items = [...stripMenu.querySelectorAll('.rb-list button:not([hidden])')];
    const i = items.indexOf(document.activeElement);
    const go = { ArrowDown: i + 1, ArrowUp: i < 0 ? items.length - 1 : i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (go !== undefined && items.length) { e.preventDefault(); items[(go + items.length) % items.length].focus(); }
    else if (e.key === 'Enter' && e.target.classList.contains('rb-filter') && items[0]) { e.preventDefault(); items[0].click(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeStripMenu(true); }
  });
  document.addEventListener('click', (e) => { if (!stripMenu.hidden && !e.target.closest('.rb-menu')) closeStripMenu(); });
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
    // tab request dipindah dari host (Open in http.me): edit tertunda dikirim dulu ke blok asalnya
    if (m.blocks && m.active !== activeBlock) flush();
    if (m.type === 'state') {
      docDirty = m.dirty;
      paintSave();
      req = m.req;
      renderRequest();
    }
    if (m.type === 'authSaved') authDirty = false;
    if (m.type === 'authSource' && m.index === activeBlock) {
      authSource = typeof m.source === 'string' ? m.source : undefined;
      authSourceIndex = activeBlock;
      renderAuth();
    }
    if (m.type === 'authSecretMoved' && typeof m.name === 'string') $('authNotice').textContent = `Moved to secret variable {{${m.name}}}.`;
    if (m.type === 'authInfo' && typeof m.text === 'string') $('authNotice').textContent = m.text;
    if (m.type === 'authError' && typeof m.message === 'string') $('authNotice').textContent = m.message;
    if (m.blocks) renderBlocks(m.blocks, m.active);
    if (m.type === 'vars') { vars = { ok: m.ok, nulls: m.nulls, names: m.names }; syncMirrors(); askSnippet(); }
    if (m.type === 'snippetCopied') { $('cpCopy').classList.add('done'); $('cpCopy').title = 'Copied'; setTimeout(() => { $('cpCopy').classList.remove('done'); $('cpCopy').title = 'Copy snippet'; }, 1500); }
    if (m.type === 'snippet') { $('cpText').textContent = m.text; $('cpNote').textContent = m.secrets ? 'Secret values are shown as ********.' : ''; }
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
  window.addEventListener('blur', flushAuthChange);
  post({ type: 'ready' });
  post({ type: 'scriptsGet' });
})();
