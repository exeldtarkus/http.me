// model sidebar http.me (tanpa vscode): mode view, isi folder Collections, ringkasan request, filter
import { parseRequest, splitBlocks } from './httpFile';

export type SidebarMode = 'collections' | 'environments' | 'open' | 'cookies';
export const MODES: SidebarMode[] = ['collections', 'environments', 'open', 'cookies'];
const TITLES: Record<SidebarMode, string> = { collections: 'Collections', environments: 'Environments', open: 'Open', cookies: 'Cookies' };

/** mode tersimpan (workspaceState) divalidasi; default Collections */
export const modeOf = (v: unknown): SidebarMode => (MODES.includes(v as SidebarMode) ? (v as SidebarMode) : 'collections');
export const viewTitle = (m: SidebarMode): string => TITLES[m];

/**
 * anak folder `parent` ('' = root) dari daftar file .http (path relatif '/'), plus folder kosong yang punya .httpmekeep.
 * Tampilan rata: semua file, tanpa folder.
 */
export function folderChildren(files: string[], keepDirs: string[], parent: string, flat: boolean): { folders: string[]; files: string[] } {
  if (flat) return { folders: [], files: [...files].sort() };
  const prefix = parent ? `${parent}/` : '';
  const folders = new Set<string>();
  const own: string[] = [];
  for (const p of [...files, ...keepDirs.map((d) => `${d}/`)]) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest) continue; // penanda folder kosong itu sendiri
    const slash = rest.indexOf('/');
    if (slash < 0) own.push(p);
    else if (rest.slice(0, slash)) folders.add(prefix + rest.slice(0, slash));
  }
  return { folders: [...folders].sort(), files: own.sort() };
}

/** label tree: method + host request pertama, judul ### dan jumlah request di file */
export type RequestSummary = { method: string | undefined; host: string; url: string; title: string | undefined; count: number };
export function requestSummary(text: string): RequestSummary {
  const blocks = splitBlocks(text);
  if (!blocks.length) return { method: undefined, host: '', url: '', title: undefined, count: 0 };
  const r = parseRequest(blocks[0].text);
  // host: bagian setelah skema sampai '/' pertama; URL berisi {{var}} tidak bisa di-parse URL, jadi dipotong manual
  const host = r.url.replace(/^[a-z][\w+.-]*:\/\//i, '').split(/[/?#]/)[0];
  return { method: r.method, host, url: r.url, title: r.title, count: blocks.length };
}

/** filter Collections: nama file (termasuk folder), method, atau URL mengandung teks filter */
export function filterFiles<T extends { path: string; method?: string; url?: string }>(items: T[], filter: string): T[] {
  const f = filter.trim().toLowerCase();
  if (!f) return items;
  return items.filter((i) => [i.path, i.method ?? '', i.url ?? ''].some((s) => s.toLowerCase().includes(f)));
}

/** tab terbuka untuk tampilan Open: rel = path relatif workspace ('/'), untitled = dokumen belum disimpan ke file */
export type OpenTab = { uri: string; rel: string; untitled: boolean; dirty: boolean };
/** parent khusus grup Untitled */
export const UNTITLED = '\0untitled';

/**
 * anak `parent` di tampilan Open: folder (● bila ada file belum disimpan di dalamnya), grup Untitled (di root), file.
 * Urutan file mengikuti urutan input (pin / drag sudah diterapkan pemanggil). onlyUnsaved = chip Unsaved.
 */
export function openChildren<T extends OpenTab>(tabs: T[], parent: string, flat: boolean, onlyUnsaved: boolean):
  { folders: { rel: string; dirty: boolean }[]; untitled?: { count: number; dirty: boolean }; files: T[] } {
  const shown = onlyUnsaved ? tabs.filter((t) => t.dirty) : tabs;
  if (flat) return { folders: [], files: shown };
  if (parent === UNTITLED) return { folders: [], files: shown.filter((t) => t.untitled) };
  const saved = shown.filter((t) => !t.untitled);
  const { folders, files } = folderChildren(saved.map((t) => t.rel), [], parent, false);
  const inFolder = (rel: string) => saved.filter((t) => t.rel.startsWith(`${rel}/`));
  const untitled = shown.filter((t) => t.untitled);
  return {
    folders: folders.map((rel) => ({ rel, dirty: inFolder(rel).some((t) => t.dirty) })),
    untitled: parent === '' && untitled.length ? { count: untitled.length, dirty: untitled.some((t) => t.dirty) } : undefined,
    files: saved.filter((t) => files.includes(t.rel)),
  };
}

/** urut tampil Open: pin di atas, lalu urutan tersimpan; yang belum punya urutan di belakang sesuai urutan tab (pola moonage openOrder.ts) */
export function arrangeOpen<T extends { uri: string }>(items: T[], order: string[], pinned: string[]): (T & { pinned: boolean })[] {
  const rank = new Map(order.map((u, i) => [u, i]));
  const pin = new Set(pinned);
  const sorted = items.map((x, i) => ({ x, i })).sort((a, b) => (rank.get(a.x.uri) ?? order.length + a.i) - (rank.get(b.x.uri) ?? order.length + b.i));
  const out = sorted.map(({ x }) => ({ ...x, pinned: pin.has(x.uri) }));
  return [...out.filter((x) => x.pinned), ...out.filter((x) => !x.pinned)];
}

/** urutan baru setelah drag: `moved` diletakkan sebelum `target` (undefined = paling bawah) */
export function moveInOrder(shown: string[], moved: string[], target: string | undefined): string[] {
  if (target !== undefined && moved.includes(target)) return shown;
  const rest = shown.filter((u) => !moved.includes(u));
  const at = target === undefined ? rest.length : rest.indexOf(target);
  rest.splice(at < 0 ? rest.length : at, 0, ...moved.filter((u) => shown.includes(u)));
  return rest;
}

/** nama file default Save request baru dari path URL: /pos/log/post -> log-post.http */
export function defaultFileName(url: string): string {
  const path = url.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '').replace(/^\{\{[^}]*\}\}/, '').split(/[?#]/)[0];
  const parts = path.split('/').map((p) => p.replace(/\{\{|\}\}/g, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean);
  return `${parts.slice(-2).join('-') || 'request'}.http`;
}
