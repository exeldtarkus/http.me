// model collection untuk export (Fase 5c): daftar file relatif (.http, _auth.http, *-request.js, _variables.json) -> pohon, tanpa vscode
import { posix } from 'node:path';
import { parseEnvironment, type EnvVar } from './environments';
import { blockLabel, parseRequest, splitBlocks, type ParsedRequest } from './httpFile';

export type ExportFile = { path: string; content: string };
export type ExportRequest = { kind: 'request'; name: string; req: ParsedRequest; pre: string; post: string };
export type ExportFolder = { kind: 'folder'; name: string; /** teks setelah `# @auth` */ auth?: string; pre: string; post: string; items: ExportNode[] };
export type ExportNode = ExportRequest | ExportFolder;
export type ExportCollection = ExportFolder & { vars: EnvVar[]; warnings: string[] };

const stripScript = (s: string) => { const m = /^\{%([\s\S]*)%\}$/.exec(s.trim()); return m ? m[1].trim() : s; };

/** pohon dari daftar file (path relatif ke folder collection, pemisah `/`) */
export function buildCollection(name: string, files: readonly ExportFile[]): ExportCollection {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const warnings: string[] = [];
  const root: ExportCollection = { kind: 'folder', name, pre: '', post: '', items: [], vars: [], warnings };
  const folders = new Map<string, ExportFolder>([['', root]]);
  const folder = (dir: string): ExportFolder => {
    let f = folders.get(dir);
    if (f) return f;
    const parent = folder(posix.dirname(dir) === '.' ? '' : posix.dirname(dir));
    f = { kind: 'folder', name: posix.basename(dir), pre: '', post: '', items: [] };
    parent.items.push(f);
    folders.set(dir, f);
    return f;
  };
  const dirOf = (p: string) => (posix.dirname(p) === '.' ? '' : posix.dirname(p));
  const script = (httpDir: string, ref: string) => {
    const content = byPath.get(posix.normalize(posix.join(httpDir, ref)));
    if (content === undefined) warnings.push(`Script file not found: ${ref}`);
    return content ?? '';
  };
  const join = (parts: string[]) => parts.map((p) => p.replace(/\n+$/, '')).filter((p) => p.trim() !== '').join('\n');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = dirOf(f.path);
    const base = posix.basename(f.path);
    if (base === '.httpmekeep') folder(dir);
    else if (base === '_auth.http') folder(dir).auth = parseRequest(f.content).auth;
    else if (base === 'pre-request.js') folder(dir).pre = f.content.replace(/\n+$/, '');
    else if (base === 'post-request.js') folder(dir).post = f.content.replace(/\n+$/, '');
    else if (base === '_variables.json') {
      if (dir === '') root.vars = parseEnvironment(f.content, base).filter((v) => v.enabled !== false);
      else warnings.push(`${f.path}: folder variables are not exported`);
    } else if (/\.http$/i.test(base)) {
      const stem = base.replace(/\.http$/i, '');
      const blocks = splitBlocks(f.content);
      const reqs = blocks.length > 1 ? blocks.map((b) => parseRequest(b.text)) : [parseRequest(f.content)];
      if (reqs.length === 1 && reqs[0].url === '') continue;
      reqs.forEach((req, i) => {
        const own = (kind: 'pre' | 'post') => (reqs.length === 1 ? byPath.get(`${dir ? `${dir}/` : ''}${stem}.${kind}-request.js`) ?? '' : '');
        folder(dir).items.push({
          kind: 'request', name: reqs.length === 1 ? req.title || stem : blockLabel(req), req,
          pre: join([...req.preScripts.map((s) => (/^\{%/.test(s.trim()) ? stripScript(s) : script(dir, s))), own('pre')]),
          post: join([...req.postScripts.map((s) => (/^\{%/.test(s.trim()) ? stripScript(s) : script(dir, s))), own('post')]),
        });
        void i;
      });
    }
  }
  // folder dulu (A-Z), lalu request (A-Z)
  const sort = (f: ExportFolder) => {
    f.items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
    for (const i of f.items) if (i.kind === 'folder') sort(i);
  };
  sort(root);
  return root;
}
