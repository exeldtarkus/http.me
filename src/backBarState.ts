// daftar editor yang dibuka dari Dashboard (tanpa vscode): tombol "Back to Dashboard" hanya tampil di sini
export class OpenedSet {
  private items = new Set<string>();
  constructor(private onChange: (list: string[]) => void) {}
  add(key: string): void { if (this.items.has(key)) return; this.items.add(key); this.onChange([...this.items]); }
  delete(key: string): void { if (this.items.delete(key)) this.onChange([...this.items]); }
  has(key: string): boolean { return this.items.has(key); }
  /** lepas yang tidak lagi terbuka */
  prune(stillOpen: ReadonlySet<string>): void {
    let changed = false;
    for (const k of [...this.items]) if (!stillOpen.has(k)) { this.items.delete(k); changed = true; }
    if (changed) this.onChange([...this.items]);
  }
}
