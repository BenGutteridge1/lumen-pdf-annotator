export interface LocalStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MobileToolbarPreferences {
  restore(hash: string): boolean;
  save(hash: string, collapsed: boolean): void;
}

const MAX_ENTRIES = 2000;
const HASH = /^[a-f0-9]{64}$/;

/** Device-local UI preferences follow the PDF content through renames/moves. */
export class PdfToolbarStateStore {
  private states: Record<string, boolean> = {};
  private readonly key: string;
  private storageFailed = false;

  constructor(vaultName: string, private readonly storage: LocalStateStorage | null) {
    this.key = `lumen-pdf-annotator:mobile-toolbar:v1:${encodeURIComponent(vaultName)}`;
  }

  resolve(hash: string, defaultCollapsed: boolean): boolean {
    const saved = this.read()[hash];
    if (typeof saved === "boolean") return saved;
    // Remember first-open defaults too: changing the global preference must
    // not change a PDF that has already been left in a particular state.
    this.save(hash, defaultCollapsed);
    return defaultCollapsed;
  }

  save(hash: string, collapsed: boolean): void {
    if (!HASH.test(hash)) return;
    const states = this.read();
    if (states[hash] === collapsed) return;
    delete states[hash];
    states[hash] = collapsed;
    this.states = Object.fromEntries(Object.entries(states).slice(-MAX_ENTRIES));
    try {
      this.storage?.setItem(this.key, JSON.stringify({ version: 1, pdfs: this.states }));
    } catch (error) {
      this.storageFailed = true;
      console.warn("Lumen could not save the local PDF toolbar state", error);
    }
  }

  private read(): Record<string, boolean> {
    if (!this.storage || this.storageFailed) return this.states;
    try {
      const text = this.storage.getItem(this.key);
      if (!text) return this.states;
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) return this.states;
      const stored = value as { version?: unknown; pdfs?: unknown };
      if (stored.version !== 1 || !stored.pdfs || typeof stored.pdfs !== "object" || Array.isArray(stored.pdfs)) return this.states;
      this.states = Object.fromEntries(Object.entries(stored.pdfs)
        .filter(([hash, collapsed]) => HASH.test(hash) && typeof collapsed === "boolean")
        .slice(-MAX_ENTRIES));
    } catch (error) {
      console.warn("Lumen could not read the local PDF toolbar state", error);
    }
    return this.states;
  }
}
