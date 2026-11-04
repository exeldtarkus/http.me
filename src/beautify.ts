// tombol Beautify di Body (tanpa vscode): JSON / XML dirapikan, {{variable}} tetap utuh
import { prettyXml } from './response';

export type Beautified = { text: string; error?: undefined } | { text?: undefined; error: string };

/** {{var}} di luar string JSON diganti string placeholder (supaya JSON valid), di dalam string diganti teks placeholder */
function protect(text: string): { json: string; restore: (s: string) => string } {
  const vars: string[] = [];
  let out = '';
  let quote = ''; // kutip string yang sedang terbuka (" atau ' untuk JSON longgar)
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2);
      if (end > 0) {
        const n = vars.push(text.slice(i, end + 2)) - 1;
        out += quote ? `__HTTPME_STR_${n}__` : `"__HTTPME_RAW_${n}__"`;
        i = end + 1;
        continue;
      }
    }
    if (quote && c === '\\') { out += c + (text[i + 1] ?? ''); i++; continue; }
    if (c === quote) quote = '';
    else if (!quote && (c === '"' || c === "'")) quote = c;
    out += c;
  }
  const restore = (s: string) => s.replace(/"__HTTPME_RAW_(\d+)__"|__HTTPME_STR_(\d+)__/g, (_m, raw: string, str: string) => vars[Number(raw ?? str)]);
  return { json: out, restore };
}

/** JSON longgar → JSON: key tanpa kutip dikutip, 'string' → "string", koma sebelum } / ] dan komentar (// dan blok) dibuang */
export function repairJson(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let body = '';
      let j = i + 1;
      for (; j < s.length && s[j] !== c; j++) {
        if (s[j] === '\\') { body += s[j + 1] === "'" ? "'" : s[j] + (s[j + 1] ?? ''); j++; }
        else body += s[j] === '"' ? '\\"' : s[j];
      }
      out += c === '"' ? s.slice(i, j + 1) : `"${body}"`;
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      i--;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 1;
    } else if (c === ',' && /^\s*[}\]]/.test(s.slice(i + 1))) {
      // koma akhir: dibuang
    } else if (/[A-Za-z_$]/.test(c)) {
      const word = /^[\w$]+/.exec(s.slice(i))![0];
      out += /^\s*:/.test(s.slice(i + word.length)) ? `"${word}"` : word;
      i += word.length - 1;
    } else out += c;
  }
  return out;
}

export function beautifyBody(text: string, type: string): Beautified {
  if (type === 'json') {
    const p = protect(text);
    try {
      // repairJson tidak mengubah JSON yang sudah valid
      return { text: p.restore(JSON.stringify(JSON.parse(repairJson(p.json)), null, 2)) };
    } catch (e) {
      // body tidak valid: pesan ke user, body tidak diubah (bukan error program)
      return { error: `Body is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (type === 'xml') {
    const x = prettyXml(text);
    return x === undefined ? { error: 'Body is not valid XML.' } : { text: x };
  }
  return { error: 'Beautify works for JSON or XML bodies.' };
}
