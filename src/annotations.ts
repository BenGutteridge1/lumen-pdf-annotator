/**
 * annotations.ts — annotation data model + sidecar persistence.
 *
 * Storage: a human-readable Markdown sidecar. Managed document bundles give it
 * a path-independent canonical location; central and old beside-the-PDF paths
 * remain supported as migration sources. It has a prose list (for skimming /
 * future back-links) AND a fenced ```json block that is the machine source of
 * truth. Geometry is stored in PDF USER-SPACE units (origin bottom-left, y-up)
 * so it is scale-independent and survives zoom / re-render / window resize.
 */
import type { DataAdapter } from "obsidian";
import { debounce, normalizePath } from "obsidian";

export interface PdfRect {
  // PDF user space (same convention as viewport.convertToPdfPoint).
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The visual STYLE axis, orthogonal to color/meaning. Stored on each mark.
 * Absent on legacy marks → treated as "highlight" (see markStyleOf), so old
 * sidecars stay fully valid without migration.
 */
export type MarkStyle =
  | "highlight" // semi-transparent fill
  | "underline" // solid underline
  | "dashed" // dashed underline
  | "dotted" // dotted underline
  | "strike" // strikethrough
  | "box" // outlined rectangle around the text
  | "comment"; // "naked" note anchored to a span (quiet dotted underline, no fill)

export const MARK_STYLES: MarkStyle[] = [
  "highlight",
  "underline",
  "dashed",
  "dotted",
  "strike",
  "box",
  "comment",
];

/** Human label for menus / prose. */
export const MARK_STYLE_LABELS: Record<MarkStyle, string> = {
  highlight: "Highlight",
  underline: "Underline",
  dashed: "Dashed underline",
  dotted: "Dotted underline",
  strike: "Strikethrough",
  box: "Box",
  comment: "Comment",
};

/** Coerce an unknown/absent style to a valid one (legacy marks default to fill). */
export function markStyleOf(h: { style?: string } | null | undefined): MarkStyle {
  const s = (h?.style ?? "highlight") as MarkStyle;
  return MARK_STYLES.includes(s) ? s : "highlight";
}

export interface Highlight {
  id: string;
  type?: "highlight" | "tag"; // absent on old sidecars => text highlight
  page: number; // 0-based page index
  color: string; // rgba/hex — the COLOR/meaning axis (a palette `fill` value)
  style?: MarkStyle; // the STYLE axis; absent ⇒ "highlight" (backward compatible)
  text: string; // selected / quoted text
  note?: string; // user comment (carried over from legacy import)
  tags?: string[]; // lightweight searchable labels, edited per annotation
  noteContentCJK?: string; // legacy storage key for the optional side note
  rects: PdfRect[]; // one rect per visual line
  tagX?: number; // percentage of page width, for page-note tags
  tagY?: number; // percentage of page height, for page-note tags
  tagColor?: string; // optional tag color; falls back to color
  isPinned?: boolean; // whether the margin card stays expanded / visible
  marginSide?: "left" | "right" | "auto"; // explicit override, otherwise source-based
  /** Quote context, kept for robustness / future re-anchoring. */
  context?: { prefix?: string; suffix?: string };
  created: string; // ISO timestamp
  source?: "manual" | "import";
}

export interface AnnotationDoc {
  version: 1;
  pdf: string; // vault-relative path of the PDF
  fingerprint?: string; // pdf.js document fingerprint (sanity only)
  highlights: Highlight[];
}

export type AnnotationStorageMode = "folder" | "beside-pdf";

export interface AnnotationPathOptions {
  storageMode?: AnnotationStorageMode;
  storageFolder?: string;
}

export const DEFAULT_ANNOTATION_FOLDER = "PDF annotations";

/**
 * The COLOR/meaning palette. Fills should read like real marker/pen colors,
 * while the painted alpha is capped in the renderer so text remains legible.
 * `ink` is a near-opaque darker version used for line styles.
 */
export interface PaletteEntry {
  name: string;
  fill: string; // stored on the mark as `color`
  ink: string; // derived stroke color for line/box styles
  emoji: string;
  cardFill?: string; // optional calmer tint for margin cards
  highlightAlpha?: number; // optional painted alpha for marker-like fills
}

export const PALETTE: PaletteEntry[] = [
  {
    name: "yellow",
    fill: "#FFD21C",
    ink: "rgba(184, 128, 0, 0.96)",
    emoji: "🟨",
    cardFill: "rgba(255, 210, 28, 0.24)",
    highlightAlpha: 0.58,
  },
  { name: "green", fill: "#86C966", ink: "rgba(61, 139, 54, 0.96)", emoji: "🟩", cardFill: "rgba(134, 201, 102, 0.2)", highlightAlpha: 0.5 },
  { name: "blue", fill: "#74A2EA", ink: "rgba(50, 105, 190, 0.96)", emoji: "🟦", cardFill: "rgba(116, 162, 234, 0.2)", highlightAlpha: 0.5 },
  { name: "purple", fill: "#B47DE3", ink: "rgba(126, 69, 185, 0.96)", emoji: "🟪", cardFill: "rgba(180, 125, 227, 0.2)", highlightAlpha: 0.5 },
  { name: "pink", fill: "#E96FA8", ink: "rgba(190, 58, 125, 0.96)", emoji: "🩷", cardFill: "rgba(233, 111, 168, 0.2)", highlightAlpha: 0.5 },
];

/** name → fill, kept for any code that wants the simple map. */
export const HL_COLORS: Record<string, string> = Object.fromEntries(
  PALETTE.map((p) => [p.name, p.fill])
);
export const DEFAULT_COLOR = PALETTE[0].fill;

/**
 * Old/pre-refinement fills → current palette name. Lets legacy marks render
 * with the current picker palette WITHOUT rewriting the sidecar: we never
 * mutate the stored string, we only resolve it at paint time.
 */
const LEGACY_FILL_TO_NAME: Record<string, string> = {
  "#FBF719": "yellow",
  "rgba(255, 214, 0, 0.40)": "yellow",
  "rgba(232, 194, 76, 0.42)": "yellow",
  "rgba(255, 224, 46, 0.52)": "yellow",
  "rgba(106, 217, 126, 0.42)": "green",
  "rgba(124, 178, 122, 0.42)": "green",
  "rgba(90, 170, 255, 0.40)": "blue",
  "rgba(72, 158, 255, 0.42)": "blue",
  "rgba(180, 125, 227, 0.42)": "purple",
  "rgba(255, 130, 200, 0.42)": "pink",
  "rgba(255, 76, 174, 0.46)": "pink",
  "rgba(255, 110, 110, 0.42)": "pink",
  "rgba(246, 94, 82, 0.44)": "pink",
};

/**
 * Resolve any stored color to a palette entry (current fills, legacy fills, or
 * a normalized key match). Returns null for genuinely custom colors.
 */
export function resolvePalette(color: string): PaletteEntry | null {
  const norm = color.replace(/\s+/g, "");
  for (const p of PALETTE) if (p.fill.replace(/\s+/g, "") === norm) return p;
  const legacyName = LEGACY_FILL_TO_NAME[color] ?? LEGACY_FILL_TO_NAME[norm];
  if (legacyName) return PALETTE.find((p) => p.name === legacyName) ?? null;
  for (const [legacy, name] of Object.entries(LEGACY_FILL_TO_NAME)) {
    if (legacy.replace(/\s+/g, "") === norm) return PALETTE.find((p) => p.name === name) ?? null;
  }
  return null;
}

export function newId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

function colorEmoji(color: string): string {
  return resolvePalette(color)?.emoji ?? "🟨";
}

function pdfAnnotationStem(pdfVaultPath: string): string {
  return normalizePath(pdfVaultPath).replace(/\.pdf$/i, "");
}

export function normalizeAnnotationStorageFolder(folder: string | null | undefined): string {
  const normalized = normalizePath((folder ?? "").trim() || DEFAULT_ANNOTATION_FOLDER)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized || DEFAULT_ANNOTATION_FOLDER;
}

/** Derive the legacy beside-the-PDF sidecar path from a PDF's vault path. */
export function legacySidecarPathFor(pdfVaultPath: string): string {
  return pdfAnnotationStem(pdfVaultPath) + ".annotations.md";
}

/**
 * Derive the active sidecar path from a PDF's vault path and storage settings.
 *
 * Folder mode mirrors the PDF's vault-relative path under the annotation folder:
 * "Books/Novel.pdf" -> "PDF annotations/Books/Novel.annotations.md".
 */
export function sidecarPathFor(
  pdfVaultPath: string,
  options: AnnotationPathOptions = {}
): string {
  if (options.storageMode === "folder") {
    const folder = normalizeAnnotationStorageFolder(options.storageFolder);
    return normalizePath(`${folder}/${pdfAnnotationStem(pdfVaultPath)}.annotations.md`);
  }
  return legacySidecarPathFor(pdfVaultPath);
}

export function serializeAnnotations(doc: AnnotationDoc, pdfBasename: string): string {
  const ordered = [...doc.highlights].sort(
    (a, b) => a.page - b.page || a.created.localeCompare(b.created)
  );
  const lines: string[] = [];
  lines.push("---");
  lines.push("lpa-annotations: 1");
  lines.push(`pdf: ${JSON.stringify(doc.pdf)}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Annotations — ${pdfBasename}`);
  lines.push("");
  lines.push(
    "<!-- Managed by PDF Annotator. The ```json block at the bottom is the " +
      "source of truth; the list above is for reading. Editing the prose is safe; " +
      "keep the json block intact. -->"
  );
  lines.push("");
  if (ordered.length === 0) {
    lines.push("_No highlights yet._");
  } else {
    for (const h of ordered) {
      const isTag = h.type === "tag";
      const text = (h.note || h.text || "Page note").replace(/\s+/g, " ").trim();
      const short = text.length > 220 ? text.slice(0, 217) + "…" : text;
      const st = markStyleOf(h);
      const styleTag = isTag
        ? " _(tag)_"
        : st === "highlight"
          ? ""
          : ` _(${MARK_STYLE_LABELS[st].toLowerCase()})_`;
      let line = `- **p.${h.page + 1}** ${colorEmoji(h.tagColor ?? h.color)}${styleTag} ^${h.id} — "${short}"`;
      if (!isTag && h.note && h.note.trim()) line += `\n  - 📝 ${h.note.replace(/\s+/g, " ").trim()}`;
      if (h.noteContentCJK && h.noteContentCJK.trim()) line += `\n  - ${h.noteContentCJK.replace(/\s+/g, " ").trim()}`;
      lines.push(line);
    }
  }
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(doc, null, 2));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

/** Extract the last ```json fenced block and parse it. Tolerant of missing/garbled files. */
export function parseAnnotations(content: string): AnnotationDoc | null {
  const fenceRe = /```json\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fenceRe.exec(content)) !== null) last = match[1];
  if (!last) return null;
  try {
    const parsed = JSON.parse(last);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.highlights)) return null;
    return parsed as AnnotationDoc;
  } catch {
    return null;
  }
}

type StoreOperation =
  | { op: "put"; annotation: Highlight }
  | { op: "patch"; id: string; patch: Partial<Highlight> }
  | { op: "remove"; id: string }
  | { op: "meta"; pdf: string; basename: string };

export type StoreChange =
  | { type: "add" | "update" | "remove"; id: string; page: number }
  | { type: "reset" };

/**
 * Indexed, journalled annotation store.
 *
 * Hot-path reads are O(1) by id/page. Edits are coalesced into a tiny append-only
 * journal, so typing in a note never serializes thousands of annotations or
 * rewrites an iCloud file. `flush()` checkpoints the journal into the existing
 * human-readable Markdown sidecar on view close/export.
 */
export class AnnotationStore {
  doc: AnnotationDoc;
  private dirty = false;
  private idIndex = new Map<string, Highlight>();
  private positionIndex = new Map<string, number>();
  private pageIndex = new Map<number, Highlight[]>();
  private sortedCache: Highlight[] | null = null;
  private listeners = new Set<(change: StoreChange) => void>();
  private pendingOps = new Map<string, StoreOperation>();
  private journalWrite: () => void;
  private journalPromise: Promise<void> = Promise.resolve();
  private journalPath: string;

  constructor(
    private adapter: DataAdapter,
    private sidecarPath: string,
    private pdfBasename: string,
    pdfVaultPath: string,
    fingerprint?: string,
    private loadFallbackPaths: string[] = [],
    private migrateFallbackOnLoad = false,
    private sidecarBackupPath?: string
  ) {
    this.doc = { version: 1, pdf: pdfVaultPath, fingerprint, highlights: [] };
    this.journalPath = sidecarPath.replace(/\.md$/i, "") + ".journal.jsonl";
    this.journalWrite = debounce(() => void this.flushJournal(), 700, true);
  }

  async load(): Promise<void> {
    let loadedFrom = "";
    const paths = [this.sidecarPath, ...this.loadFallbackPaths].filter(
      (path, index, all) => path && all.indexOf(path) === index
    );
    for (const path of paths) {
      try {
        if (!(await this.adapter.exists(path))) continue;
        const parsed = parseAnnotations(await this.adapter.read(path));
        if (!parsed) continue;
        this.doc.highlights = parsed.highlights;
        if (parsed.fingerprint) this.doc.fingerprint = parsed.fingerprint;
        loadedFrom = path;
        break;
      } catch {
        /* try the next recovery candidate */
      }
    }
    this.rebuildIndexes();
    await this.replayJournal();
    this.emit({ type: "reset" });

    if (loadedFrom && this.migrateFallbackOnLoad && loadedFrom !== this.sidecarPath) {
      this.dirty = true;
      await this.flush();
    }
  }

  get size(): number {
    return this.idIndex.size;
  }

  allSorted(): readonly Highlight[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.idIndex.values()].sort(
        (a, b) => a.page - b.page || a.created.localeCompare(b.created)
      );
    }
    return this.sortedCache;
  }

  byPage(page: number): readonly Highlight[] {
    return this.pageIndex.get(page) ?? [];
  }

  get(id: string): Highlight | undefined {
    return this.idIndex.get(id);
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  add(h: Highlight): void {
    this.putLocal(h);
    this.queueOperation(`put:${h.id}`, { op: "put", annotation: h });
    this.emit({ type: "add", id: h.id, page: h.page });
  }

  addMany(hs: Highlight[]): void {
    for (const h of hs) {
      this.putLocal(h);
      this.queueOperation(`put:${h.id}`, { op: "put", annotation: h });
    }
    this.emit({ type: "reset" });
  }

  remove(id: string): void {
    const current = this.idIndex.get(id);
    if (!current) return;
    const position = this.positionIndex.get(id);
    if (position !== undefined) {
      const last = this.doc.highlights.pop();
      if (last && last.id !== id) {
        this.doc.highlights[position] = last;
        this.positionIndex.set(last.id, position);
      }
    }
    this.idIndex.delete(id);
    this.positionIndex.delete(id);
    const pageItems = this.pageIndex.get(current.page);
    if (pageItems) {
      const i = pageItems.findIndex((item) => item.id === id);
      if (i >= 0) pageItems.splice(i, 1);
      if (!pageItems.length) this.pageIndex.delete(current.page);
    }
    this.sortedCache = null;
    this.queueOperation(`remove:${id}`, { op: "remove", id });
    this.emit({ type: "remove", id, page: current.page });
  }

  update(id: string, patch: Partial<Highlight>): void {
    const h = this.idIndex.get(id);
    if (!h) return;
    const previousPage = h.page;
    Object.assign(h, patch);
    if (h.page !== previousPage) {
      const previousItems = this.pageIndex.get(previousPage);
      const i = previousItems?.findIndex((item) => item.id === id) ?? -1;
      if (previousItems && i >= 0) previousItems.splice(i, 1);
      if (previousItems && !previousItems.length) this.pageIndex.delete(previousPage);
      this.addToPageIndex(h);
    }
    this.sortedCache = null;
    const key = `patch:${id}`;
    const pending = this.pendingOps.get(key);
    const merged = pending?.op === "patch" ? { ...pending.patch, ...patch } : patch;
    this.queueOperation(key, { op: "patch", id, patch: merged });
    this.emit({ type: "update", id, page: h.page });
  }

  setPdfPath(pdfVaultPath: string, pdfBasename: string): void {
    if (this.doc.pdf === pdfVaultPath && this.pdfBasename === pdfBasename) return;
    this.doc.pdf = pdfVaultPath;
    this.pdfBasename = pdfBasename;
    this.queueOperation("meta", { op: "meta", pdf: pdfVaultPath, basename: pdfBasename });
  }

  /** Persist queued edits immediately without creating the full snapshot. */
  async syncJournal(): Promise<void> {
    await this.flushJournal();
    await this.journalPromise;
  }

  /** Compact the crash journal into the canonical Markdown snapshot. */
  async flush(): Promise<void> {
    await this.syncJournal();
    if (!this.dirty) return;
    const out = serializeAnnotations(this.doc, this.pdfBasename);
    try {
      await this.ensureParentFolder(this.sidecarPath);
      if (this.sidecarBackupPath && (await this.adapter.exists(this.sidecarPath))) {
        const current = await this.adapter.read(this.sidecarPath);
        if (parseAnnotations(current)) {
          await this.ensureParentFolder(this.sidecarBackupPath);
          await this.adapter.write(this.sidecarBackupPath, current);
        }
      }
      await this.adapter.write(this.sidecarPath, out);
      await this.adapter.write(this.journalPath, "");
      this.dirty = false;
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  private queueOperation(key: string, operation: StoreOperation): void {
    this.dirty = true;
    this.pendingOps.set(key, operation);
    this.journalWrite();
  }

  private async flushJournal(): Promise<void> {
    if (!this.pendingOps.size) return this.journalPromise;
    const operations = [...this.pendingOps.values()];
    this.pendingOps.clear();
    const payload = operations.map((op) => JSON.stringify(op)).join("\n") + "\n";
    this.journalPromise = this.journalPromise.then(async () => {
      await this.ensureParentFolder(this.journalPath);
      const append = (this.adapter as DataAdapter & {
        append?: (path: string, data: string) => Promise<void>;
      }).append;
      if (typeof append === "function") {
        await append.call(this.adapter, this.journalPath, payload);
      } else {
        const existing = (await this.adapter.exists(this.journalPath))
          ? await this.adapter.read(this.journalPath)
          : "";
        await this.adapter.write(this.journalPath, existing + payload);
      }
    });
    return this.journalPromise;
  }

  private async replayJournal(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.journalPath))) return;
      const lines = (await this.adapter.read(this.journalPath)).split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        let operation: StoreOperation;
        try {
          operation = JSON.parse(line) as StoreOperation;
        } catch {
          continue;
        }
        if (operation.op === "put") this.putLocal(operation.annotation);
        else if (operation.op === "patch") {
          const current = this.idIndex.get(operation.id);
          if (current) Object.assign(current, operation.patch);
        } else if (operation.op === "remove") this.removeLocal(operation.id);
        else if (operation.op === "meta") {
          this.doc.pdf = operation.pdf;
          this.pdfBasename = operation.basename;
        }
      }
      this.rebuildIndexes();
      this.dirty = lines.some((line) => !!line.trim());
    } catch {
      /* A damaged final line cannot make the canonical snapshot unreadable. */
    }
  }

  private putLocal(h: Highlight): void {
    const existing = this.idIndex.get(h.id);
    if (existing) {
      const position = this.positionIndex.get(h.id);
      if (position !== undefined) this.doc.highlights[position] = h;
      const pageItems = this.pageIndex.get(existing.page);
      const pagePosition = pageItems?.findIndex((item) => item.id === h.id) ?? -1;
      if (pageItems && pagePosition >= 0) pageItems.splice(pagePosition, 1);
    } else {
      this.positionIndex.set(h.id, this.doc.highlights.length);
      this.doc.highlights.push(h);
    }
    this.idIndex.set(h.id, h);
    this.addToPageIndex(h);
    this.sortedCache = null;
  }

  private removeLocal(id: string): void {
    const current = this.idIndex.get(id);
    if (!current) return;
    this.doc.highlights = this.doc.highlights.filter((item) => item.id !== id);
    this.rebuildIndexes();
  }

  private addToPageIndex(h: Highlight): void {
    const items = this.pageIndex.get(h.page) ?? [];
    items.push(h);
    this.pageIndex.set(h.page, items);
  }

  private rebuildIndexes(): void {
    this.idIndex.clear();
    this.positionIndex.clear();
    this.pageIndex.clear();
    this.doc.highlights.forEach((h, index) => {
      this.idIndex.set(h.id, h);
      this.positionIndex.set(h.id, index);
      this.addToPageIndex(h);
    });
    this.sortedCache = null;
  }

  private emit(change: StoreChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private async ensureParentFolder(filePath: string): Promise<void> {
    const parent = normalizePath(filePath).split("/").slice(0, -1).join("/");
    if (!parent) return;
    const parts = parent.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const stat = await this.adapter.stat(current);
      if (stat?.type === "folder") continue;
      if (stat) throw new Error(`Cannot create annotation folder because ${current} is a file.`);
      try {
        await this.adapter.mkdir(current);
      } catch (error) {
        if ((await this.adapter.stat(current))?.type !== "folder") throw error;
      }
    }
  }
}
