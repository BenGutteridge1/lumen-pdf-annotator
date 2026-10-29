import type { Vault } from "obsidian";

export interface ReadingPosition {
  page: number;
  updatedAt: number;
}

interface SharedReadingState {
  version: 1;
  position: ReadingPosition;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEVICE_PATTERN = /^[a-z0-9-]{1,64}$/;

// Each PDF bundle already has a hidden directory. Keep its reading position
// beside annotations. A file per device lets Git merge page updates without
// making two devices edit the same JSON. The old shared file remains readable
// for migration but is never written again.
export function sharedReadingStatePath(hash: string, deviceId: string): string {
  if (!HASH_PATTERN.test(hash)) throw new Error("Invalid PDF identity");
  if (!DEVICE_PATTERN.test(deviceId)) throw new Error("Invalid device identity");
  return `.lumen-pdf/bundles/sha256/${hash}/reading-position.${deviceId}.json`;
}

export function legacySharedReadingStatePath(hash: string): string {
  if (!HASH_PATTERN.test(hash)) throw new Error("Invalid PDF identity");
  return `.lumen-pdf/bundles/sha256/${hash}/reading-position.json`;
}

export function isSharedReadingStatePath(path: string): boolean {
  return /^\.lumen-pdf\/bundles\/sha256\/[a-f0-9]{64}\/reading-position(?:\.[a-z0-9-]{1,64})?\.json$/.test(path);
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
  constructor(private readonly vault: Vault, private readonly deviceId: string) {}

  async read(hash: string): Promise<ReadingPosition | null> {
    if (!HASH_PATTERN.test(hash)) throw new Error("Invalid PDF identity");
    const folder = `.lumen-pdf/bundles/sha256/${hash}`;
    const positions: ReadingPosition[] = [];
    const legacy = await this.readFile(legacySharedReadingStatePath(hash));
    if (legacy) positions.push(legacy);
    const listing = await this.vault.adapter.list(folder);
    const prefix = `${folder}/reading-position.`;
    for (const path of listing.files) {
      if (!path.startsWith(prefix) || !/^[a-z0-9-]{1,64}\.json$/.test(path.slice(prefix.length))) continue;
      const position = await this.readFile(path);
      if (position) positions.push(position);
    }
    return positions.reduce<ReadingPosition | null>((latest, position) => newerPosition(latest, position), null);
  }

  private async readFile(path: string): Promise<ReadingPosition | null> {
    if (!(await this.vault.adapter.exists(path))) return null;
    try {
      const value: unknown = JSON.parse(await this.vault.adapter.read(path));
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const stored = value as Partial<SharedReadingState>;
      if (stored.version !== 1) return null;
      return readingPosition(stored.position);
    } catch {
      // A partially synced legacy file cannot block valid device-specific files.
      return null;
    }
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
    const path = sharedReadingStatePath(hash, this.deviceId);
    const current = await this.readFile(path);
    if (current && current.updatedAt >= position.updatedAt) return current;
    await this.vault.adapter.write(path, `${JSON.stringify({ version: 1, position }, null, 2)}\n`);
    return position;
  }
}
