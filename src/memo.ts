// disalin dari moonage-daydream src/memo.ts; tambahan: registry supaya Clear Cache bisa mengosongkan semua ttlCache
const all = new Set<{ clear(): void }>();

/** cache promise per key dengan umur (ms); fresh = selalu muat ulang lalu simpan; promise gagal tidak disimpan */
export function ttlCache(ms: number, now: () => number = Date.now) {
  const map = new Map<string, { at: number; value: Promise<unknown> }>();
  const cache = {
    get<T>(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
      const hit = map.get(key);
      if (!fresh && hit && now() - hit.at <= ms) return hit.value as Promise<T>;
      const value = load();
      map.set(key, { at: now(), value });
      // gagal: dibuang supaya percobaan berikutnya memuat ulang (error tetap sampai ke pemanggil)
      value.catch(() => { if (map.get(key)?.value === value) map.delete(key); }); // error dicatat pemanggil
      return value;
    },
    clear: () => map.clear(),
  };
  all.add(cache);
  return cache;
}

/** Clear Cache: kosongkan semua ttlCache di memory */
export const clearAllCaches = (): void => all.forEach((c) => c.clear());
