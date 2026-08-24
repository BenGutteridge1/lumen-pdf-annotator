export type MarkStyle = "highlight" | "underline" | "dashed" | "dotted" | "strike" | "box" | "comment";

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfAnnotation {
  id: string;
  groupId?: string;
  kind?: "text" | "page-note";
  page: number;
  rects: NormalizedRect[];
  quote: string;
  note: string;
  tags: string[];
  color: string;
  style: MarkStyle;
  createdAt: number;
  updatedAt: number;
}

export type AnnotationMutation =
  | { op: "put"; annotation: PdfAnnotation }
  | { op: "remove"; id: string; at: number };

export const MARK_COLORS = ["#ffd12d", "#83cb67", "#6f9fe8", "#aa78df", "#e463a1"] as const;

export class AnnotationIndex {
  private readonly items = new Map<string, PdfAnnotation>();
  private readonly pages = new Map<number, Set<string>>();
  private readonly groups = new Map<string, Set<string>>();
  private readonly searchable = new Map<string, string>();
  // Map has no reverse iterator. Keep an append-only recency log so the
  // inspector can request only its visible newest/oldest window without
  // materialising hundreds of thousands of annotations first.
  private logicalOrder: string[] = [];
  private readonly logicalPosition = new Map<string, number>();
  private revision = 0;
  private cachedRevision = -1;
  private cachedAll: PdfAnnotation[] = [];
  private cachedLogicalRevision = -1;
  private cachedLogicalAll: PdfAnnotation[] = [];

  get version(): number {
    return this.revision;
  }

  get size(): number {
    return this.items.size;
  }

  get logicalSize(): number {
    return this.groups.size;
  }

  get(id: string): PdfAnnotation | undefined {
    return this.items.get(id);
  }

  groupId(annotation: PdfAnnotation): string {
    return annotation.groupId || annotation.id;
  }

  inGroup(idOrGroupId: string): PdfAnnotation[] {
    const annotation = this.items.get(idOrGroupId);
    const groupId = annotation ? this.groupId(annotation) : idOrGroupId;
    const ids = this.groups.get(groupId);
    if (!ids) return [];
    const result: PdfAnnotation[] = [];
    for (const id of ids) {
      const value = this.items.get(id);
      if (value) result.push(value);
    }
    return result;
  }

  put(annotation: PdfAnnotation): void {
    const previous = this.items.get(annotation.id);
    const previousGroupId = previous ? this.groupId(previous) : null;
    if (previous && previous.page !== annotation.page) {
      this.pages.get(previous.page)?.delete(annotation.id);
    }
    if (previousGroupId) {
      const previousGroup = this.groups.get(previousGroupId);
      previousGroup?.delete(annotation.id);
      if (previousGroup?.size === 0) {
        this.groups.delete(previousGroupId);
        this.logicalPosition.delete(previousGroupId);
      }
    }
    // Map/Set insertion order doubles as a mutation-time index. Moving an
    // existing id to the end makes newest/oldest inspector views linear
    // instead of sorting the full collection after every edit.
    if (previous) this.items.delete(annotation.id);
    this.items.set(annotation.id, annotation);
    this.searchable.set(annotation.id, `${annotation.quote}\u0000${annotation.note}\u0000${annotation.tags.join(" ")}\u0000${annotation.page}`.toLowerCase());
    let pageIds = this.pages.get(annotation.page);
    if (!pageIds) {
      pageIds = new Set();
      this.pages.set(annotation.page, pageIds);
    }
    pageIds.delete(annotation.id);
    pageIds.add(annotation.id);
    const groupId = this.groupId(annotation);
    let groupIds = this.groups.get(groupId);
    if (!groupIds) groupIds = new Set();
    groupIds.delete(annotation.id);
    groupIds.add(annotation.id);
    // Mutation order is also the logical annotation recency index.
    this.groups.delete(groupId);
    this.groups.set(groupId, groupIds);
    this.touchLogicalGroup(groupId);
    this.revision++;
  }

  remove(id: string): boolean {
    const annotation = this.items.get(id);
    if (!annotation) return false;
    this.items.delete(id);
    this.searchable.delete(id);
    const groupId = this.groupId(annotation);
    const groupIds = this.groups.get(groupId);
    groupIds?.delete(id);
    if (groupIds?.size === 0) {
      this.groups.delete(groupId);
      this.logicalPosition.delete(groupId);
    }
    const pageIds = this.pages.get(annotation.page);
    pageIds?.delete(id);
    if (pageIds?.size === 0) this.pages.delete(annotation.page);
    this.revision++;
    return true;
  }

  onPage(page: number): PdfAnnotation[] {
    const ids = this.pages.get(page);
    if (!ids) return [];
    const result: PdfAnnotation[] = [];
    for (const id of ids) {
      const value = this.items.get(id);
      if (value) result.push(value);
    }
    return result;
  }

  all(): PdfAnnotation[] {
    if (this.cachedRevision !== this.revision) {
      this.cachedAll = Array.from(this.items.values());
      this.cachedRevision = this.revision;
    }
    return this.cachedAll;
  }

  logicalAll(): PdfAnnotation[] {
    if (this.cachedLogicalRevision === this.revision) return this.cachedLogicalAll;
    this.cachedLogicalAll = this.logicalSlice(0, this.logicalSize);
    this.cachedLogicalRevision = this.revision;
    return this.cachedLogicalAll;
  }

  logicalSlice(start: number, end: number, newestFirst = false): PdfAnnotation[] {
    const first = Math.max(0, Math.trunc(start));
    const last = Math.min(this.logicalSize, Math.max(first, Math.trunc(end)));
    if (first >= last) return [];
    const result: PdfAnnotation[] = [];
    let logicalIndex = 0;
    const step = newestFirst ? -1 : 1;
    for (let position = newestFirst ? this.logicalOrder.length - 1 : 0;
      position >= 0 && position < this.logicalOrder.length;
      position += step) {
      const groupId = this.logicalOrder[position];
      if (this.logicalPosition.get(groupId) !== position) continue;
      if (logicalIndex >= first) {
        const annotation = this.logicalAnnotation(groupId);
        if (annotation) result.push(annotation);
      }
      logicalIndex++;
      if (logicalIndex >= last) break;
    }
    return result;
  }

  private logicalAnnotation(groupId: string): PdfAnnotation | undefined {
    const anchor = this.items.get(groupId);
    if (anchor) return anchor;
    const ids = this.groups.get(groupId);
    if (!ids) return undefined;
    for (const id of ids) {
      const value = this.items.get(id);
      if (value) return value;
    }
    return undefined;
  }

  private touchLogicalGroup(groupId: string): void {
    const position = this.logicalOrder.length;
    this.logicalOrder.push(groupId);
    this.logicalPosition.set(groupId, position);
    this.compactLogicalOrderIfNeeded();
  }

  private compactLogicalOrderIfNeeded(): void {
    const toleratedStaleEntries = Math.max(1_024, Math.floor(this.groups.size / 8));
    if (this.logicalOrder.length <= this.groups.size + toleratedStaleEntries) return;
    this.logicalOrder = Array.from(this.groups.keys());
    this.logicalPosition.clear();
    for (let position = 0; position < this.logicalOrder.length; position++) {
      this.logicalPosition.set(this.logicalOrder[position], position);
    }
  }

  matches(annotation: PdfAnnotation, normalizedQuery: string): boolean {
    return this.searchable.get(annotation.id)?.includes(normalizedQuery) ?? false;
  }

  apply(mutation: AnnotationMutation): void {
    if (mutation.op === "put") this.put(mutation.annotation);
    else this.remove(mutation.id);
  }
}

export function newAnnotation(
  page: number,
  rects: NormalizedRect[],
  quote: string,
  color: string,
  style: MarkStyle,
): PdfAnnotation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    kind: "text",
    page,
    rects,
    quote,
    note: "",
    tags: [],
    color,
    style,
    createdAt: now,
    updatedAt: now,
  };
}

export function newPageNote(page: number, x: number, y: number, color: string): PdfAnnotation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    kind: "page-note",
    page,
    rects: [{ x, y, width: 0.034, height: 0.034 }],
    quote: "Page note",
    note: "",
    tags: [],
    color,
    style: "comment",
    createdAt: now,
    updatedAt: now,
  };
}
