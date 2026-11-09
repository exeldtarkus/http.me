// hapus ke trash; provider remote (WSL, SSH) tidak punya trash -> konfirmasi lalu hapus permanen (tanpa vscode)
export type Deleted = 'trash' | 'permanent' | 'cancelled';

const NO_TRASH = /trash|does not support/i;

export async function deleteWithFallback<T>(
  target: T, del: (target: T, useTrash: boolean) => PromiseLike<void>, confirmPermanent: () => PromiseLike<boolean>,
): Promise<Deleted> {
  try {
    await del(target, true);
    return 'trash';
  } catch (e) {
    if (!NO_TRASH.test(e instanceof Error ? e.message : String(e))) throw e; // error lain (izin, dsb.) tetap sampai ke pemanggil yang mencatat log
  }
  if (!(await confirmPermanent())) return 'cancelled';
  await del(target, false);
  return 'permanent';
}
