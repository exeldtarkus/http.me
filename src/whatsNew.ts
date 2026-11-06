import { esc, webviewPage } from './webviewPage';

export type ReleaseItem = { kind: 'new' | 'improved' | 'fixed'; title: string; detail?: string };
export type Release = { version: string; date: string; items: ReleaseItem[] };

/** catatan rilis halaman What's New, terbaru di atas; wajib ada entri baru tiap rilis MINOR */
export const RELEASES: Release[] = [
  {
    version: '0.2.0', date: '2026-11-05', items: [
      { kind: 'new', title: 'Code snippet panel' },
      { kind: 'new', title: 'Open: choose Text Editor or http.me UI', detail: 'Hover icon and right-click menu.' },
      { kind: 'improved', title: 'Environments tree', detail: 'Globals on top, uniform icons, active Environment in green.' },
      { kind: 'improved', title: 'Faster sidebar', detail: 'Scan and file summaries are cached and warmed up on activation.' },
      { kind: 'fixed', title: 'Http.Me section no longer blank on first open' },
    ],
  },
  {
    version: '0.0.1', date: '2026-11-04', items: [
      { kind: 'new', title: "What's New", detail: 'This page: it opens once after every update to a newer version.' },
    ],
  },
];

/** halaman muncul tiap versi naik (major / minor / patch) atau install baru; downgrade & versi sama tidak */
export function isNewerVersion(current: string, previous: string | undefined): boolean {
  if (!previous) return true;
  const c = current.split('.').map(Number);
  const p = previous.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((c[i] ?? 0) !== (p[i] ?? 0)) return (c[i] ?? 0) > (p[i] ?? 0);
  return false;
}

const KIND = { new: 'New', improved: 'Improved', fixed: 'Fixed' };

function releaseHtml(r: Release, latest: boolean, active: boolean): string {
  const count = (['new', 'improved', 'fixed'] as const)
    .map((k) => [k, r.items.filter((i) => i.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `<span class="count ${k}">${n} ${KIND[k].toLowerCase()}</span>`).join('');
  const items = r.items.map((i) => `<li><span class="kind ${i.kind}">${KIND[i.kind]}</span><div><strong>${esc(i.title)}</strong>${i.detail ? `<p>${esc(i.detail)}</p>` : ''}</div></li>`).join('');
  return `<details${latest || active ? ' open' : ''} class="release">
<summary><span class="ver">v${esc(r.version)}</span>${latest ? '<span class="latest">Latest</span>' : ''}${active ? '<span class="active">Active</span>' : ''}<time>${esc(r.date)}</time><span class="counts">${count}</span></summary>
<ul>${items}</ul>
</details>`;
}

/** halaman What's New (statis, tanpa script) */
export function whatsNewHtml(cspSource: string, installed: string, releases: Release[] = RELEASES): string {
  return webviewPage('whatsNew', {
    cspSource,
    installed: esc(installed),
    releases: (releases.some((r) => r.version === installed) ? '' : `<p class="note">No release notes for v${esc(installed)}.</p>\n`)
      + releases.map((r, i) => releaseHtml(r, i === 0, r.version === installed)).join('\n'),
  });
}
