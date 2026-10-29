import type { Vault } from "obsidian";

export interface ReadingPosition {
  page: number;
  updatedAt: number;
}

interface SharedReadingState {
  version: 1;
  position: ReadingPosition;
}

// Each PDF bundle already has a hidden directory. Keep its reading position
// beside annotations so vault sync carries both without a separate folder or
// Markdown note. Plugin data.json is excluded by common Git sync defaults.
export function sharedReadingStatePath(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid PDF identity");
  return `.lumen-pdf/bundles/sha256/${hash}/reading-position.json`;
}

export function isSharedReadingStatePath(path: string): boolean {
  return /^\.lumen-pdf\/bundles\/sha256\/[a-f0-9]{64}\/reading-position\.json$/.test(path);
}

export function readingPosition(value: unknown): ReadingPosition | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ReadingPosition>;
  if (typeof item.page !== "number" || !Number.isFinite(item.page) || item.page < 1
    || typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt) || item.updatedAt < 0) return null;
  return { page: Math.round(item.page), updatedAt: item.updatedAt };
}

export function newerPosition(a: ReadingPosition | null, b: ReadingPosition | null): ReadingPosition | null {
  return !a || (b && b.updatedAt > a.updatedAt) ? b : a;
}

export class ReadingPositionStore {
  constructor(private readonly vault: Vault) {}

  async read(hash: string): Promise<ReadingPosition | null> {
    const path = sharedReadingStatePath(hash);
    if (!(await this.vault.adapter.exists(path))) return null;
    const text = await this.vault.adapter.read(path);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Lumen shared reading state");
    const stored = value as Partial<SharedReadingState>;
    if (stored.version !== 1) throw new Error("Invalid Lumen shared reading state");
    return readingPosition(stored.position);
  }

  /** Reads 1.0.27's sidecar once during upgrade; all new writes use bundle JSON. */
  async readLegacy(hash: string): Promise<ReadingPosition | null> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid PDF identity");
    const path = `Lumen PDF state/${hash}.md`;
    if (!(await this.vault.adapter.exists(path))) return null;
    const text = await this.vault.adapter.read(path);
    const page = /^lumen-page: (\d+)$/m.exec(text)?.[1];
    const updatedAt = /^lumen-updated-at: (\d+)$/m.exec(text)?.[1];
    return readingPosition({ page: Number(page), updatedAt: Number(updatedAt) });
  }

  async save(hash: string, position: ReadingPosition): Promise<ReadingPosition> {
    const current = await this.read(hash);
    if (current && current.updatedAt >= position.updatedAt) return current;
    const path = sharedReadingStatePath(hash);
    await this.vault.adapter.write(path, `${JSON.stringify({ version: 1, position }, null, 2)}\n`);
    return position;
  }
}
