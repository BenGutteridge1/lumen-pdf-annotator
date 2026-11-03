import type { Vault } from "obsidian";
import { MARK_COLORS } from "./model";

export type AnnotationColour = typeof MARK_COLORS[number];

export const ANNOTATION_COLOUR_NAMES: Record<AnnotationColour, string> = {
  "#ffd12d": "Yellow",
  "#83cb67": "Green",
  "#6f9fe8": "Blue",
  "#aa78df": "Purple",
  "#e463a1": "Pink",
};

export const DEFAULT_ANNOTATION_COLOUR = MARK_COLORS[0];
export const VAULT_ANNOTATION_COLOUR_PATH = ".lumen-pdf/preferences.json";

export function annotationColour(value: unknown): AnnotationColour | undefined {
  return MARK_COLORS.find(colour => colour === value);
}

export class AnnotationColourPreference {
  private readonly listeners = new Set<() => void>();

  constructor(private current?: AnnotationColour) {}

  get colour(): AnnotationColour | undefined { return this.current; }

  update(colour: AnnotationColour | undefined): void {
    if (this.current === colour) return;
    this.current = colour;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function resolveAnnotationColour(
  pdf?: AnnotationColourPreference,
  vault?: AnnotationColourPreference,
): AnnotationColour {
  return pdf?.colour ?? vault?.colour ?? DEFAULT_ANNOTATION_COLOUR;
}

export class VaultAnnotationColour extends AnnotationColourPreference {
  private pending: Promise<void> = Promise.resolve();
  private refresh: Promise<void> | undefined;
  private saved: AnnotationColour = DEFAULT_ANNOTATION_COLOUR;
  private revision = 0;

  constructor(private readonly vault: Vault) {
    super(DEFAULT_ANNOTATION_COLOUR);
  }

  load(): Promise<void> {
    if (this.refresh) return this.refresh;
    const revision = this.revision;
    const { adapter } = this.vault;
    this.refresh = this.pending.then(async () => {
      const path = VAULT_ANNOTATION_COLOUR_PATH;
      const text = await adapter.exists(path) ? await adapter.read(path) : "";
      if (revision !== this.revision) return;
      let stored: AnnotationColour | undefined;
      try {
        stored = annotationColour((JSON.parse(text || "null") as { defaultAnnotationColour?: unknown } | null)?.defaultAnnotationColour);
      } catch { /* malformed preferences fall back to the initial colour */ }
      this.saved = stored ?? DEFAULT_ANNOTATION_COLOUR;
      this.update(this.saved);
    }).catch(error => console.warn("Lumen could not read the vault annotation colour", error))
      .finally(() => { this.refresh = undefined; });
    return this.refresh;
  }

  save(colour: AnnotationColour): Promise<void> {
    if (this.colour === colour && this.saved === colour) return this.pending;
    this.revision++;
    this.update(colour);
    const { adapter } = this.vault;
    const write = this.pending.then(async () => {
      if (this.saved === colour) return;
      const folder = ".lumen-pdf";
      if (!(await adapter.exists(folder))) {
        try { await adapter.mkdir(folder); }
        catch (error) { if (!(await adapter.exists(folder))) throw error; }
      }
      await adapter.write(VAULT_ANNOTATION_COLOUR_PATH, JSON.stringify({ version: 1, defaultAnnotationColour: colour }, null, 2));
      this.saved = colour;
    });
    this.pending = write.catch(() => {});
    return write;
  }
}
