import { esc, webviewPage } from './webviewPage';

export type ReleaseItem = { kind: 'new' | 'improved' | 'fixed'; title: string; detail?: string };
export type Release = { version: string; date: string; items: ReleaseItem[] };

/** catatan rilis halaman What's New, terbaru di atas; wajib ada entri baru tiap rilis MINOR */
export const RELEASES: Release[] = [
  {
    version: '0.0.1', date: '2026-11-04', items: [
      { kind: 'new', title: "What's New", detail: 'This page: it opens once after an update to a new minor version.' },
    ],
  },
];

/** halaman hanya muncul saat naik minor / major (atau install baru), tidak untuk patch */
export function isNewerMinor(current: string, previous: string | undefined): boolean {
  if (!previous) return true;
  const [curMajor, curMinor] = current.split('.').map(Number);
  const [prevMajor, prevMinor] = previous.split('.').map(Number);
  return curMajor > prevMajor || (curMajor === prevMajor && curMinor > prevMinor);
}

const KIND = { new: 'New', improved: 'Improved', fixed: 'Fixed' };

function releaseHtml(r: Release, latest: boolean): string {
  const count = (['new', 'improved', 'fixed'] as const)
    .map((k) => [k, r.items.filter((i) => i.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `<span class="count ${k}">${n} ${KIND[k].toLowerCase()}</span>`).join('');
  const items = r.items.map((i) => `<li><span class="kind ${i.kind}">${KIND[i.kind]}</span><div><strong>${esc(i.title)}</strong>${i.detail ? `<p>${esc(i.detail)}</p>` : ''}</div></li>`).join('');
  return `<details${latest ? ' open' : ''} class="release">
<summary><span class="ver">v${esc(r.version)}</span>${latest ? '<span class="latest">Latest</span>' : ''}<time>${esc(r.date)}</time><span class="counts">${count}</span></summary>
<ul>${items}</ul>
</details>`;
}

/** halaman What's New (statis, tanpa script) */
export function whatsNewHtml(cspSource: string, installed: string, releases: Release[] = RELEASES): string {
  return webviewPage('whatsNew', {
    cspSource,
    installed: esc(installed),
    releases: releases.map((r, i) => releaseHtml(r, i === 0)).join('\n'),
  });
}
