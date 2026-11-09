// terjemahan script Postman `pm.*` -> `httpme.*` per baris (best-effort, tabel di FITUR.md 6e), tanpa vscode
export type Translated = { code: string; warnings: string[] };

const UNSUPPORTED: [RegExp, string][] = [
  [/\bpm\.sendRequest\b/, 'pm.sendRequest'], [/\bpm\.visualizer\b/, 'pm.visualizer'], [/\bpm\.iterationData\b/, 'pm.iterationData'], [/\brequire\s*\(/, 'require()'],
];

// urutan penting: bentuk panjang (assertion) sebelum rename awalan
const RULES: [RegExp, string][] = [
  [/pm\.response\.to\.have\.status\(([^)]*)\)/g, 'httpme.expect.equal(httpme.response.status, $1)'],
  [/pm\.expect\((.+?)\)\.to\.eql\((.*)\)/g, 'httpme.expect.deepEqual($1, $2)'],
  [/pm\.expect\((.+?)\)\.to\.(?:equal|eq)\((.*)\)/g, 'httpme.expect.equal($1, $2)'],
  [/pm\.expect\((.+?)\)\.to\.include\((.*)\)/g, 'httpme.expect.ok($1.includes($2))'],
  [/pm\.expect\((.+?)\)\.to\.be\.true\b/g, 'httpme.expect.equal($1, true)'],
  [/pm\.request\.headers\.(?:add|upsert)\(\s*\{\s*key:\s*([^,]+?),\s*value:\s*([^}]+?)\s*\}\s*\)/g, 'httpme.request.headers.set($1, $2)'],
  [/pm\.environment\./g, 'httpme.environment.'],
  [/pm\.variables\./g, 'httpme.vars.'],
  [/pm\.collectionVariables\./g, 'httpme.collection.'],
  [/pm\.globals\./g, 'httpme.globals.'],
  [/pm\.test\(/g, 'httpme.test('],
  [/pm\.response\.code\b/g, 'httpme.response.status'],
  [/pm\.response\.status\b(?!\()/g, 'httpme.response.statusText'],
  [/pm\.response\.responseTime\b/g, 'httpme.response.time'],
  [/pm\.response\.(json|text|headers)\b/g, 'httpme.response.$1'],
  [/pm\.request\.headers\.remove\b/g, 'httpme.request.headers.remove'],
  [/pm\.request\.url\b/g, 'httpme.request.url'],
  [/pm\.cookies\.get\b/g, 'httpme.cookies.get'],
];

/** baris yang tidak bisa diterjemahkan menjadi `// httpme: not supported — <alasan>: <baris asli>` + peringatan */
export function translateScript(src: string): Translated {
  const warnings: string[] = [];
  const code = src.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const bad = (reason: string) => {
      warnings.push(`${reason} is not supported: ${line.trim()}`);
      return `// httpme: not supported — ${reason}: ${line.trim()}`;
    };
    for (const [re, reason] of UNSUPPORTED) if (re.test(line)) return bad(reason);
    let out = line;
    for (const [re, to] of RULES) out = out.replace(re, to);
    const left = /\bpm\.\w+/.exec(out);
    return left ? bad(left[0]) : out;
  }).join('\n');
  return { code, warnings };
}
