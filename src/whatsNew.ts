import { esc, webviewPage } from './webviewPage';

export type ReleaseItem = { kind: 'new' | 'improved' | 'fixed'; title: string; detail?: string };
export type Release = { version: string; date: string; items: ReleaseItem[] };

/** catatan rilis halaman What's New, terbaru di atas; wajib ada entri baru tiap rilis MINOR */
export const RELEASES: Release[] = [
  {
    version: '1.2.0', date: '2026-11-09', items: [
      { kind: 'new', title: 'Reorder Collections', detail: 'Right-click a request or folder and choose Move Up / Move Down, or drag a request onto another one in the same folder. Works in the sidebar and in the Dashboard. The order is saved in .httpme/order.json, so your team shares it.' },
      { kind: 'new', title: 'Copy a cookie', detail: 'Copy Value and Copy as name=value copy the real value, not the masked one.' },
      { kind: 'new', title: 'Rename a cookie', detail: 'Change the key of a saved cookie. A name that already exists for the same domain and path is refused.' },
      { kind: 'improved', title: 'Edit Value shows the current value', detail: 'The input box is filled with the saved value so you can change it instead of retyping it.' },
    ],
  },
  {
    version: '1.1.0', date: '2026-11-09', items: [
      { kind: 'new', title: 'History in the Dashboard', detail: 'A History tab with filters by text and date. Click a request to open it with its saved response and the time it was executed; every entry opens in the same unsaved history.http tab.' },
      { kind: 'new', title: 'Backups of History and unsaved requests', detail: 'Saved automatically to exports/history-backup and exports/temp-backup (once a day, or when they grow by 2 MB). Use the Backups tab or "http.me: Back Up History and Temp Now" to back up, and "http.me: Import History or Temp Backup…" to restore.' },
      { kind: 'new', title: 'Set Active button in the Dashboard', detail: 'Every Environment that is not active now shows a visible Set Active button.' },
      { kind: 'improved', title: 'History keeps response headers', detail: 'Set-Cookie is never stored.' },
      { kind: 'improved', title: 'Response panel follows a slow request', detail: 'When an older request finishes after you sent another one, the Response panel switches to its result.' },
      { kind: 'fixed', title: 'A running request no longer loses its response when you switch tabs' },
      { kind: 'fixed', title: 'Close All in Open asks to save unsaved requests', detail: 'Applies to Close All, Close All Unpinned and the close button on a single tab.' },
    ],
  },
  {
    version: '1.0.4', date: '2026-11-09', items: [
      { kind: 'new', title: 'Request timeout setting', detail: 'Set how long a request may run with the httpme.request.timeout setting, or run "http.me: Set Request Timeout…" from the Command Palette. A "# @timeout" line in a request still overrides it.' },
      { kind: 'improved', title: 'Longer default timeout', detail: 'Requests now time out after 10 minutes instead of 30 seconds.' },
    ],
  },
  {
    version: '1.0.3', date: '2026-11-09', items: [
      { kind: 'new', title: 'First release on the VS Code Marketplace and Open VSX', detail: 'Versions 1.0.0 to 1.0.2 were built but not published. Everything listed under v1.0.0 is in this release.' },
    ],
  },
  {
    version: '1.0.0', date: '2026-11-09', items: [
      { kind: 'new', title: 'Dashboard', detail: 'Collections, Environments and Cookies on one page. Open it with Ctrl+Alt+D (Cmd+Alt+D on macOS).' },
      { kind: 'new', title: 'Environments and variables', detail: 'NULL for unfilled values, Globals, collection variables, secret values in SecretStorage, and import / export of http-client.env.json.' },
      { kind: 'new', title: 'Authorization', detail: '12 types, including OAuth 2.0, Digest and AWS Signature.' },
      { kind: 'new', title: 'Cookies and login sessions', detail: 'A cookie jar per Environment and automatic re-login when a session expires.' },
      { kind: 'new', title: 'Scripts', detail: 'pre-request.js and post-request.js per folder or request, with tests and console output.' },
      { kind: 'new', title: 'Import', detail: 'cURL, Postman Collection and Environment, OpenAPI / Swagger (JSON or YAML) from a file or URL, with a preview and re-import from the source.' },
      { kind: 'new', title: 'Export', detail: 'To Postman Collection v2.1 or OpenAPI 3.0.3 / 3.1.0 with a live preview and request selection. Secrets are never written unless you confirm.' },
      { kind: 'new', title: 'History with response bodies', detail: 'The last 200 requests, used to fill response examples when you export OpenAPI.' },
      { kind: 'improved', title: 'Keyboard and sidebar', detail: 'Delete works on the selected item, Close All Unpinned in Open, and a Back to Dashboard bar.' },
    ],
  },
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
