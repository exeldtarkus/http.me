// nama & isi awal tab New Request (tanpa vscode)
export const NEW_REQUEST_TEXT = 'GET https://\n';

/** "New Request <n>.http" dengan n terkecil yang belum dipakai tab untitled lain */
export function newRequestName(openNames: string[]): string {
  const used = new Set(openNames);
  let n = 1;
  while (used.has(`New Request ${n}.http`)) n++;
  return `New Request ${n}.http`;
}
