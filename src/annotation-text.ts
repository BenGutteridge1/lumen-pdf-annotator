import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { AnnotationQuoteRange, NormalizedRect, PdfAnnotation } from "./model";

export interface QuoteTextRun extends AnnotationQuoteRange {
  separatorBefore: string;
}

export interface QuoteRunSlice {
  index: number;
  start: number;
  end: number;
}

const LATIN_LIGATURES: Record<string, string> = {
  "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st",
};

export function normalizeQuoteText(value: string): string {
  // NFKC also changes superscripts, mathematical symbols and other meaningful
  // PDF characters. Expand only the unambiguous Latin presentation ligatures.
  return value.replace(/[ﬀ-ﬆ]/g, character => LATIN_LIGATURES[character])
    .replaceAll("\u0000", "�").replace(/\s+/g, " ").trim();
}

function separatedItems(previous: TextItem, next: TextItem): boolean {
  // Vertical writing uses a different advance axis; keep its explicit PDF
  // breaks rather than applying horizontal word-gap estimates to each glyph.
  if (previous.dir === "ttb" || next.dir === "ttb") return false;
  const [a, b, c, d, x, y] = previous.transform as number[];
  const nextTransform = next.transform as number[];
  const fontSize = Math.max(Math.hypot(a, b), Math.hypot(c, d), previous.height, next.height, .001);
  const advanceSize = Math.hypot(a, b);
  if (!advanceSize) return false;
  const dx = nextTransform[4] - x;
  const dy = nextTransform[5] - y;
  const along = (dx * a + dy * b) / advanceSize;
  const across = Math.abs(dx * b - dy * a) / advanceSize;
  if (across > fontSize * .35) return true;
  const gap = previous.dir === "rtl"
    ? -along - next.width
    : along - previous.width;
  return gap > fontSize * .15;
}

/** Uses PDF coordinates, independent of zoom, and keeps adjacent word runs intact. */
export function buildQuoteTextRuns(items: readonly TextItem[]): QuoteTextRun[] {
  let offset = 0;
  let previous: TextItem | undefined;
  let pendingEol = false;
  return items.map(item => {
    const separatorBefore = item.str && previous && !/\s$/.test(previous.str) && !/^\s/.test(item.str)
      && (pendingEol || separatedItems(previous, item)) ? " " : "";
    offset += separatorBefore.length;
    const run = { start: offset, end: offset + item.str.length, text: item.str, separatorBefore };
    offset = run.end;
    pendingEol ||= item.hasEOL;
    if (item.str) {
      previous = item;
      pendingEol = item.hasEOL;
    }
    return run;
  });
}

/** Clips by the original DOM character offsets before any display expansion. */
export function quoteRangesForSlices(runs: readonly QuoteTextRun[], slices: readonly QuoteRunSlice[]): AnnotationQuoteRange[] {
  const ranges: AnnotationQuoteRange[] = [];
  for (const slice of slices) {
    const run = runs[slice.index];
    if (!run) continue;
    const start = Math.max(0, Math.min(run.text.length, slice.start));
    const end = Math.max(start, Math.min(run.text.length, slice.end));
    if (start === end) continue;
    const piece = { start: run.start + start, end: run.start + end, text: run.text.slice(start, end) };
    const previous = ranges[ranges.length - 1];
    const gap = previous ? piece.start - previous.end : -1;
    if (previous && (gap === 0 || (gap === 1 && run.separatorBefore === " " && start === 0))) {
      previous.text += (gap ? " " : "") + piece.text;
      previous.end = piece.end;
    } else ranges.push(piece);
  }
  return ranges;
}

export function normalizeQuoteRanges(value: unknown): AnnotationQuoteRange[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const ranges: AnnotationQuoteRange[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    const range = entry as Partial<AnnotationQuoteRange>;
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start! < 0 || range.end! <= range.start!
      || typeof range.text !== "string" || range.text.length !== range.end! - range.start!) return undefined;
    ranges.push({ start: range.start!, end: range.end!, text: range.text });
  }
  // Bad optional anchors must never discard the annotation itself.
  return mergeQuoteRanges(ranges) ?? undefined;
}

export function mergeQuoteRanges(ranges: readonly AnnotationQuoteRange[]): AnnotationQuoteRange[] | null {
  const ordered = ranges.slice().sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: AnnotationQuoteRange[] = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    const overlap = Math.min(previous.end, range.end) - range.start;
    if (previous.text.slice(range.start - previous.start, range.start - previous.start + overlap)
      !== range.text.slice(0, overlap)) return null;
    if (range.end > previous.end) {
      previous.text += range.text.slice(previous.end - range.start);
      previous.end = range.end;
    }
  }
  return merged;
}

export function quoteFromPageRanges(pages: ReadonlyMap<number, readonly AnnotationQuoteRange[]>): string {
  return normalizeQuoteText(Array.from(pages).sort(([left], [right]) => left - right)
    .flatMap(([, ranges]) => ranges.map(range => range.text)).join(" "));
}

interface QuotePosition {
  page: number;
  x: number;
  y: number;
}

function comparePosition(left: QuotePosition, right: QuotePosition): number {
  return left.page - right.page || (Math.abs(left.y - right.y) > .005 ? left.y - right.y : left.x - right.x);
}

function positions(pages: ReadonlyMap<number, readonly NormalizedRect[]>): QuotePosition[] {
  return Array.from(pages).flatMap(([page, rects]) => rects.map(rect => ({ page, x: rect.x, y: rect.y })))
    .sort(comparePosition);
}

function boundaryOverlap(left: string, right: string): number {
  const prefix = new Uint32Array(right.length);
  let matched = 0;
  for (let index = 1; index < right.length; index++) {
    while (matched && right[index] !== right[matched]) matched = prefix[matched - 1];
    if (right[index] === right[matched]) matched++;
    prefix[index] = matched;
  }
  matched = 0;
  for (let index = Math.max(0, left.length - right.length); index < left.length; index++) {
    while (matched && (matched === right.length || left[index] !== right[matched])) matched = prefix[matched - 1];
    if (left[index] === right[matched]) matched++;
  }
  return matched;
}

/** Old records have geometry and a quote but no character anchors. */
export function extendLegacyQuote(
  original: string,
  extension: string,
  members: readonly PdfAnnotation[],
  selectedPages: ReadonlyMap<number, readonly NormalizedRect[]>,
): string {
  const left = normalizeQuoteText(original);
  const right = normalizeQuoteText(extension);
  if (!left || !right) return left || right;
  const oldPages = new Map<number, NormalizedRect[]>();
  for (const member of members) oldPages.set(member.page, [...oldPages.get(member.page) ?? [], ...member.rects]);
  const oldPositions = positions(oldPages);
  const selectedPositions = positions(selectedPages);
  const first = selectedPositions[0];
  const oldFirst = oldPositions[0];
  if (!first || !oldFirst) return `${left} ${right}`;
  const before = comparePosition(first, oldFirst) < 0;
  const overlaps = Array.from(selectedPages).some(([page, rects]) => rects.some(rect =>
    oldPages.get(page)?.some(old => Math.min(rect.x + rect.width, old.x + old.width) > Math.max(rect.x, old.x)
      && Math.min(rect.y + rect.height, old.y + old.height) > Math.max(rect.y, old.y))));
  // Identical words at distinct locations must survive. Text overlap is only
  // useful when the actual selected rectangles overlap the saved mark.
  if (overlaps) {
    if (left.includes(right)) return left;
    if (right.includes(left)) return right;
    const overlap = before ? boundaryOverlap(right, left) : boundaryOverlap(left, right);
    if (overlap) return normalizeQuoteText(before ? right + left.slice(overlap) : left + right.slice(overlap));
  }
  return before ? `${right} ${left}` : `${left} ${right}`;
}

export interface ExtendedQuote {
  quote: string;
  rangesByPage?: Map<number, AnnotationQuoteRange[]>;
}

export function extendAnnotationQuote(
  members: readonly PdfAnnotation[],
  originalQuote: string,
  selectionQuote: string,
  selectionPages: ReadonlyMap<number, readonly NormalizedRect[]>,
  selectedRanges: ReadonlyMap<number, readonly AnnotationQuoteRange[]>,
): ExtendedQuote {
  const existing = new Map<number, AnnotationQuoteRange[]>();
  for (const member of members) {
    const ranges = normalizeQuoteRanges(member.quoteRanges);
    if (!ranges) return { quote: extendLegacyQuote(originalQuote, selectionQuote, members, selectionPages) };
    existing.set(member.page, [...existing.get(member.page) ?? [], ...ranges]);
  }
  for (const [page, ranges] of existing) {
    const merged = mergeQuoteRanges(ranges);
    if (!merged) return { quote: extendLegacyQuote(originalQuote, selectionQuote, members, selectionPages) };
    existing.set(page, merged);
  }
  // An older reader may have extended a quote while ignoring its optional
  // anchors. Do not overwrite that text using an incomplete set of ranges.
  if (quoteFromPageRanges(existing) !== normalizeQuoteText(originalQuote)
    || Array.from(selectionPages.keys()).some(page => !selectedRanges.get(page)?.length)) {
    return { quote: extendLegacyQuote(originalQuote, selectionQuote, members, selectionPages) };
  }
  for (const [page, ranges] of selectedRanges) {
    const merged = mergeQuoteRanges([...existing.get(page) ?? [], ...ranges]);
    if (!merged) return { quote: extendLegacyQuote(originalQuote, selectionQuote, members, selectionPages) };
    existing.set(page, merged);
  }
  return { quote: quoteFromPageRanges(existing), rangesByPage: existing };
}
