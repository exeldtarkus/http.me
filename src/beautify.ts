// tombol Beautify di Body (tanpa vscode): JSON / XML dirapikan, {{variable}} tetap utuh
import { prettyXml } from './response';

export type Beautified = { text: string; error?: undefined } | { text?: undefined; error: string };

/** {{var}} di luar string JSON diganti string placeholder (supaya JSON valid), di dalam string diganti teks placeholder */
function protect(text: string): { json: string; restore: (s: string) => string } {
  const vars: string[] = [];
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2);
      if (end > 0) {
        const n = vars.push(text.slice(i, end + 2)) - 1;
        out += inStr ? `__HTTPME_STR_${n}__` : `"__HTTPME_RAW_${n}__"`;
        i = end + 1;
        continue;
      }
    }
    if (inStr && c === '\\') { out += c + (text[i + 1] ?? ''); i++; continue; }
    if (c === '"') inStr = !inStr;
    out += c;
  }
  const restore = (s: string) => s.replace(/"__HTTPME_RAW_(\d+)__"|__HTTPME_STR_(\d+)__/g, (_m, raw: string, str: string) => vars[Number(raw ?? str)]);
  return { json: out, restore };
}

export function beautifyBody(text: string, type: string): Beautified {
  if (type === 'json') {
    const p = protect(text);
    try {
      return { text: p.restore(JSON.stringify(JSON.parse(p.json), null, 2)) };
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
