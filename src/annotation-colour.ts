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
  private savedPrintedPageNumbers = false;
  private printedPageNumbers = false;
  private storedPreferences: Record<string, unknown> = {};
  private revision = 0;
  private readonly printedPageNumberListeners = new Set<(show: boolean) => void>();

  constructor(private readonly vault: Vault) {
    super(DEFAULT_ANNOTATION_COLOUR);
  }

  get showPrintedPageNumbers(): boolean { return this.printedPageNumbers; }

  subscribePrintedPageNumbers(listener: (show: boolean) => void): () => void {
    this.printedPageNumberListeners.add(listener);
    return () => this.printedPageNumberListeners.delete(listener);
  }

  private updatePrintedPageNumbers(show: boolean): void {
    if (this.printedPageNumbers === show) return;
    this.printedPageNumbers = show;
    for (const listener of this.printedPageNumberListeners) listener(show);
  }

  private async readStoredPreferences(): Promise<Record<string, unknown>> {
    const path = VAULT_ANNOTATION_COLOUR_PATH;
    const text = await this.vault.adapter.exists(path) ? await this.vault.adapter.read(path) : "";
    try {
      const stored: unknown = JSON.parse(text || "{}");
      return typeof stored === "object" && stored !== null && !Array.isArray(stored)
        ? stored as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private async writeStoredPreferences(patch: Record<string, unknown>): Promise<void> {
    const { adapter } = this.vault;
    const folder = ".lumen-pdf";
    if (!(await adapter.exists(folder))) {
      try { await adapter.mkdir(folder); }
      catch (error) { if (!(await adapter.exists(folder))) throw error; }
    }
    this.storedPreferences = { ...this.storedPreferences, version: 1, ...patch };
    await adapter.write(VAULT_ANNOTATION_COLOUR_PATH, JSON.stringify(this.storedPreferences, null, 2));
  }

  load(fallbackShowPrintedPageNumbers = false): Promise<void> {
    if (this.refresh) return this.refresh;
    const revision = this.revision;
    this.refresh = this.pending.then(async () => {
      const stored = await this.readStoredPreferences();
      if (revision !== this.revision) return;
      this.storedPreferences = { ...stored };
      this.saved = annotationColour(stored.defaultAnnotationColour) ?? DEFAULT_ANNOTATION_COLOUR;
      this.savedPrintedPageNumbers = typeof stored.showPrintedPageNumbers === "boolean"
        ? stored.showPrintedPageNumbers
        : fallbackShowPrintedPageNumbers;
      this.update(this.saved);
      this.updatePrintedPageNumbers(this.savedPrintedPageNumbers);
      if (typeof stored.showPrintedPageNumbers !== "boolean" && fallbackShowPrintedPageNumbers) {
        await this.writeStoredPreferences({ showPrintedPageNumbers: true });
      }
    }).catch(error => console.warn("Lumen could not read the vault annotation colour", error))
      .finally(() => { this.refresh = undefined; });
    return this.refresh;
  }

  save(colour: AnnotationColour): Promise<void> {
    if (this.colour === colour && this.saved === colour) return this.pending;
    this.revision++;
    this.update(colour);
    const write = this.pending.then(async () => {
      if (this.saved === colour) return;
      await this.writeStoredPreferences({ defaultAnnotationColour: colour });
      this.saved = colour;
    });
    this.pending = write.catch(() => {});
    return write;
  }

  savePrintedPageNumbers(show: boolean): Promise<void> {
    if (this.showPrintedPageNumbers === show && this.savedPrintedPageNumbers === show) return this.pending;
    this.revision++;
    this.updatePrintedPageNumbers(show);
    const write = this.pending.then(async () => {
      if (this.savedPrintedPageNumbers === show) return;
      await this.writeStoredPreferences({ showPrintedPageNumbers: show });
      this.savedPrintedPageNumbers = show;
    });
    this.pending = write.catch(() => {});
    return write;
  }
}
