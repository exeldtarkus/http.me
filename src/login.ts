// login session (tanpa vscode): deteksi session habis + ulang request setelah login sekali (tidak pernah loop)
type Res = { status: number; url: string; redirects?: { url: string }[]; headers?: [string, string][] };

/** session habis: status 401/403, URL akhir / Location cocok pola (default /login) */
export function sessionExpired(res: Res, pattern: string): boolean {
  if (res.status === 401 || res.status === 403) return true;
  if (!pattern) return false;
  const hit = (u: string) => { try { return new URL(u, res.url).pathname.includes(pattern) || u.includes(pattern); } catch { return u.includes(pattern); } }; // URL aneh: dicocokkan apa adanya
  const location = res.headers?.find(([k]) => k === 'location')?.[1];
  return hit(res.url) || (location !== undefined && hit(location));
}

/** kirim; bila session habis dan ada request login: login sekali lalu kirim ulang (maks 1 kali) */
export async function sendWithRelogin<T>(run: () => Promise<T>, expired: (r: T) => boolean, login: (() => Promise<unknown>) | undefined): Promise<{ res: T; relogged: boolean }> {
  const res = await run();
  if (!login || !expired(res)) return { res, relogged: false };
  await login();
  return { res: await run(), relogged: true };
}
