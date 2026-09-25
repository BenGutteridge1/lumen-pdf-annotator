export interface PdfOutlinePageRef {
  num: number;
  gen: number;
}

export interface ResolvedOutlineEntry {
  id: string;
  title: string;
  depth: number;
  /** The page encoded in the PDF outline, retained when validation fails. */
  declaredPageNumber: number;
  pageNumber: number;
  destination: readonly unknown[];
  heading?: OutlineHeadingGeometry;
  validation: "unresolved" | "matched" | "unmatched";
}

/** The most recent navigable heading at or before the reader's current page. */
export function currentOutlineEntry(entries: readonly ResolvedOutlineEntry[], page: number): ResolvedOutlineEntry | null {
  let current: ResolvedOutlineEntry | null = null;
  for (const entry of entries) {
    if (entry.pageNumber > page) continue;
    if (!current || entry.pageNumber >= current.pageNumber) current = entry;
  }
  return current;
}

/** Center the active row unless the list has reached its first or last row. */
export function centeredOutlineScrollTop(itemTop: number, itemHeight: number, viewportHeight: number, contentHeight: number): number {
  const centered = itemTop - (viewportHeight - itemHeight) / 2;
  return Math.max(0, Math.min(centered, Math.max(0, contentHeight - viewportHeight)));
}

export interface OutlineHeadingGeometry {
  leftRatio: number;
  topRatio: number;
  widthRatio: number;
  heightRatio: number;
}

export interface OutlineSearchTextSpan {
  start: number;
  end: number;
  rect: { x: number; y: number; width: number; height: number };
}

export interface OutlineSearchPage {
  text: string;
  spans: readonly OutlineSearchTextSpan[];
}

export interface OutlineHeadingLocation {
  pageNumber: number;
  heading: OutlineHeadingGeometry;
}

export interface OutlineViewport {
  viewBox: number[];
  convertToViewportPoint(x: number, y: number): unknown[];
}

interface OutlineDocument {
  readonly numPages: number;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: PdfOutlinePageRef): Promise<number>;
  cachedPageNumber(ref: PdfOutlinePageRef): number | null;
}

interface OutlineCandidate {
  id: string;
  title: string;
  depth: number;
  destination: string | readonly unknown[];
}

interface UnknownRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isPageRef(value: unknown): value is PdfOutlinePageRef {
  return isRecord(value) && Number.isInteger(value.num) && Number.isInteger(value.gen);
}

function normalizedTitle(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function collectCandidates(outline: unknown): OutlineCandidate[] {
  if (!Array.isArray(outline)) return [];
  const candidates: OutlineCandidate[] = [];
  const stack: Array<{ node: unknown; depth: number; id: string }> = [];
  for (let index = outline.length - 1; index >= 0; index--) {
    stack.push({ node: outline[index], depth: 0, id: String(index) });
  }
  while (stack.length) {
    const current = stack.pop();
    if (!current || !isRecord(current.node)) continue;
    const children = Array.isArray(current.node.items) ? current.node.items : [];
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index], depth: current.depth + 1, id: `${current.id}.${index}` });
    }
    const title = normalizedTitle(current.node.title);
    const destination = current.node.dest;
    if (title && (typeof destination === "string" || Array.isArray(destination))) {
      candidates.push({ id: current.id, title, depth: current.depth, destination });
    }
  }
  return candidates;
}

/** Resolve a PDF outline without serially blocking on every named destination. */
export async function resolvePdfOutline(
  document: OutlineDocument,
  outline: unknown,
  concurrency = 6,
): Promise<ResolvedOutlineEntry[]> {
  const candidates = collectCandidates(outline);
  if (!candidates.length) return [];
  const resolved: Array<ResolvedOutlineEntry | null> = Array.from({ length: candidates.length }, () => null);
  const namedDestinations = new Map<string, Promise<unknown[] | null>>();
  const pageReferences = new Map<string, Promise<number | null>>();
  let cursor = 0;
  let processed = 0;

  const explicitDestination = (destination: string | readonly unknown[]): Promise<unknown[] | null> => {
    if (typeof destination !== "string") return Promise.resolve(Array.from(destination));
    let pending = namedDestinations.get(destination);
    if (!pending) {
      pending = document.getDestination(destination).catch(() => null);
      namedDestinations.set(destination, pending);
    }
    return pending;
  };

  const pageNumberFor = async (destination: readonly unknown[]): Promise<number | null> => {
    const reference = destination[0];
    if (Number.isInteger(reference)) {
      const pageNumber = Number(reference) + 1;
      return pageNumber >= 1 && pageNumber <= document.numPages ? pageNumber : null;
    }
    if (!isPageRef(reference)) return null;
    const key = `${reference.num}:${reference.gen}`;
    let pending = pageReferences.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const cached = document.cachedPageNumber(reference);
          const pageNumber = cached ?? (await document.getPageIndex(reference)) + 1;
          return pageNumber >= 1 && pageNumber <= document.numPages ? pageNumber : null;
        } catch {
          return null;
        }
      })();
      pageReferences.set(key, pending);
    }
    return pending;
  };

  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const index = cursor++;
      const candidate = candidates[index];
      const destination = await explicitDestination(candidate.destination);
      if (destination) {
        const pageNumber = await pageNumberFor(destination);
        if (pageNumber) {
          resolved[index] = {
            ...candidate,
            declaredPageNumber: pageNumber,
            pageNumber,
            destination,
            validation: "unresolved",
          };
        }
      }
      // Explicit destinations and cached page references can resolve entirely
      // through microtasks. Yield periodically so pathological outlines do not
      // monopolize the renderer thread while the PDF itself is opening.
      if (++processed % 64 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
  };
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), candidates.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  // Keep the source depth even if a structural parent has no destination of
  // its own. Flattening those gaps would misrepresent the PDF's hierarchy.
  return resolved.filter((entry): entry is ResolvedOutlineEntry => entry !== null);
}

/**
 * Return the small, deterministic neighbourhood used to validate an outline
 * destination. Forward pages win ties because stale generated outlines most
 * commonly lag behind inserted front matter.
 */
export function outlineValidationPageOrder(
  declaredPageNumber: number,
  pageCount: number,
  radius = 4,
): number[] {
  if (pageCount < 1 || declaredPageNumber < 1 || declaredPageNumber > pageCount) return [];
  const pages = [declaredPageNumber];
  for (let distance = 1; distance <= Math.max(0, Math.floor(radius)); distance++) {
    const forward = declaredPageNumber + distance;
    const backward = declaredPageNumber - distance;
    if (forward <= pageCount) pages.push(forward);
    if (backward >= 1) pages.push(backward);
  }
  return pages;
}

function titleBoundaryCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function foldedText(value: string): { text: string; starts: number[]; ends: number[] } {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < value.length;) {
    const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
    const end = index + character.length;
    const folded = character.normalize("NFKD").toLocaleLowerCase();
    text += folded;
    for (let offset = 0; offset < folded.length; offset++) {
      starts.push(index);
      ends.push(end);
    }
    index = end;
  }
  return { text, starts, ends };
}

function sameVisualLine(first: OutlineSearchTextSpan, second: OutlineSearchTextSpan): boolean {
  const firstCenter = first.rect.y + first.rect.height / 2;
  const secondCenter = second.rect.y + second.rect.height / 2;
  return Math.abs(firstCenter - secondCenter) <= Math.max(first.rect.height, second.rect.height) * .55;
}

function coherentHeadingSpans(spans: readonly OutlineSearchTextSpan[]): boolean {
  for (let index = 1; index < spans.length; index++) {
    const previous = spans[index - 1].rect;
    const current = spans[index].rect;
    const horizontalGap = Math.max(
      0,
      current.x - (previous.x + previous.width),
      previous.x - (current.x + current.width),
    );
    if (horizontalGap > .1) return false;
    if (sameVisualLine(spans[index - 1], spans[index])) {
      continue;
    } else {
      const verticalGap = current.y - (previous.y + previous.height);
      if (verticalGap < -.005 || verticalGap > Math.max(previous.height, current.height) * 2) return false;
    }
  }
  return true;
}

function isolatedHeadingLine(
  page: OutlineSearchPage,
  matching: readonly OutlineSearchTextSpan[],
  start: number,
  end: number,
): boolean {
  const prefixes: Array<{ text: string; rect: OutlineSearchTextSpan["rect"] }> = [];
  const suffixes: string[] = [];
  for (const span of matching) {
    if (span.start < start) prefixes.push({ text: page.text.slice(span.start, start), rect: span.rect });
    if (span.end > end) suffixes.push(page.text.slice(end, span.end));
  }
  const selected = new Set(matching);
  for (const span of page.spans) {
    if (selected.has(span)) continue;
    let left = Infinity;
    let right = -Infinity;
    for (const match of matching) {
      if (!sameVisualLine(match, span)) continue;
      left = Math.min(left, match.rect.x);
      right = Math.max(right, match.rect.x + match.rect.width);
    }
    if (left === Infinity) continue;
    const text = page.text.slice(span.start, span.end);
    if (span.rect.x + span.rect.width <= left + .005) prefixes.push({ text, rect: span.rect });
    else if (span.rect.x >= right - .005) suffixes.push(text);
    else return false;
  }
  if (suffixes.some(text => text.trim())) return false;
  const prefix = prefixes.sort((a, b) => a.rect.x - b.rect.x).map(part => part.text.trim()).filter(Boolean).join(" ");
  if (!prefix) return true;
  // PDF chapter/section counters may be separate text items or part of the
  // heading item itself. A folio far from the title is not such a counter.
  const prefixEnd = Math.max(...prefixes.map(part => part.rect.x + part.rect.width));
  const titleLeft = Math.min(...matching.map(span => span.rect.x));
  if (titleLeft - prefixEnd > .1) return false;
  return /^(?:(?:chapter|part|section|appendix)\s+)?(?:\d+(?:\.\d+)*\.?|[ivxlcdm]+\.?|[a-z]\.?)\s*[:.)-]?$/iu.test(prefix);
}

function geometryForRange(
  page: OutlineSearchPage,
  start: number,
  end: number,
): { geometry: OutlineHeadingGeometry; textHeight: number } | null {
  const matching = page.spans.filter(span => span.end > start && span.start < end).sort((a, b) => a.start - b.start);
  if (!matching.length) return null;
  let coveredTo = start;
  for (const span of matching) {
    if (page.text.slice(coveredTo, Math.min(span.start, end)).trim()) return null;
    coveredTo = Math.max(coveredTo, span.end);
  }
  if (page.text.slice(coveredTo, end).trim()) return null;
  if (!coherentHeadingSpans(matching) || !isolatedHeadingLine(page, matching, start, end)) return null;
  const left = Math.min(...matching.map(span => span.rect.x));
  const top = Math.min(...matching.map(span => span.rect.y));
  const right = Math.max(...matching.map(span => span.rect.x + span.rect.width));
  const bottom = Math.max(...matching.map(span => span.rect.y + span.rect.height));
  const textHeight = Math.max(...matching.map(span => span.rect.height));
  return {
    geometry: {
      leftRatio: Math.max(0, Math.min(1, left)),
      topRatio: Math.max(0, Math.min(1, top)),
      widthRatio: Math.max(0, Math.min(1, right) - Math.max(0, Math.min(1, left))),
      heightRatio: Math.max(0, Math.min(1, bottom) - Math.max(0, Math.min(1, top))),
    },
    textHeight,
  };
}

/** Locate a boundary-exact heading title and return scale-independent geometry. */
export function exactOutlineHeadingGeometry(
  page: OutlineSearchPage,
  title: string,
): OutlineHeadingGeometry | null {
  const sourceTitle = normalizedTitle(title);
  if (!sourceTitle) return null;
  const simpleNeedle = sourceTitle.toLocaleLowerCase();
  const simpleHaystack = page.text.toLocaleLowerCase();
  type HeadingMatch = { geometry: OutlineHeadingGeometry; textHeight: number };
  const search = (
    haystack: string,
    needle: string,
    previous: HeadingMatch | null,
    starts?: readonly number[],
    ends?: readonly number[],
  ): HeadingMatch | null => {
    let best = previous;
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const foldedStart = haystack.indexOf(needle, from);
      if (foldedStart < 0) break;
      const foldedEnd = foldedStart + needle.length;
      // A match must not start or end inside one expanded source glyph (for
      // example, matching just "f" against the "ffi" expansion of "ﬃ").
      if ((starts && foldedStart > 0 && starts[foldedStart] === starts[foldedStart - 1])
        || (ends && foldedEnd < ends.length && ends[foldedEnd - 1] === ends[foldedEnd])) {
        from = foldedStart + Math.max(1, needle.length);
        continue;
      }
      const start = starts?.[foldedStart] ?? foldedStart;
      const end = ends?.[foldedEnd - 1] ?? foldedEnd;
      const startsInsideWord = titleBoundaryCharacter(sourceTitle[0]) && titleBoundaryCharacter(page.text[start - 1]);
      const endsInsideWord = titleBoundaryCharacter(sourceTitle.at(-1)) && titleBoundaryCharacter(page.text[end]);
      if (!startsInsideWord && !endsInsideWord) {
        const candidate = geometryForRange(page, start, end);
        if (candidate && (!best
          || candidate.textHeight > best.textHeight
          || (candidate.textHeight === best.textHeight && candidate.geometry.topRatio < best.geometry.topRatio))) {
          best = candidate;
        }
      }
      from = foldedStart + Math.max(1, needle.length);
    }
    return best;
  };
  let best: HeadingMatch | null = null;
  if (simpleHaystack.length === page.text.length && simpleNeedle.length === sourceTitle.length) {
    best = search(simpleHaystack, simpleNeedle, best);
    if (best) return best.geometry;
  }
  // Most titles use the length-preserving fast path. Build the source-offset
  // projection only for a case-fold expansion or a possible Unicode-equivalent
  // miss (such as a decomposed accent or a typographic ligature).
  if (simpleHaystack.length !== page.text.length
    || simpleNeedle.length !== sourceTitle.length
    || sourceTitle.normalize("NFKD") !== sourceTitle
    || page.text.normalize("NFKD") !== page.text) {
    const foldedPage = foldedText(page.text);
    best = search(foldedPage.text, foldedText(sourceTitle).text, best, foldedPage.starts, foldedPage.ends);
  }
  return best?.geometry ?? null;
}

/** Search only the declared page and its bounded neighbourhood. */
export async function findExactOutlineHeading(
  title: string,
  declaredPageNumber: number,
  pageCount: number,
  readPage: (pageNumber: number) => Promise<OutlineSearchPage | null>,
): Promise<OutlineHeadingLocation | null> {
  for (const pageNumber of outlineValidationPageOrder(declaredPageNumber, pageCount)) {
    const page = await readPage(pageNumber);
    if (!page) continue;
    const heading = exactOutlineHeadingGeometry(page, title);
    if (heading) return { pageNumber, heading };
  }
  return null;
}

/** Cache a successful refinement; a miss deliberately preserves the PDF metadata. */
export function cacheOutlineHeadingLocation(
  entry: ResolvedOutlineEntry,
  location: OutlineHeadingLocation | null,
): boolean {
  if (!location) {
    entry.validation = "unmatched";
    return false;
  }
  entry.pageNumber = location.pageNumber;
  entry.heading = location.heading;
  entry.validation = "matched";
  return true;
}

export function filterOutlineEntries(
  entries: readonly ResolvedOutlineEntry[],
  query: string,
): ResolvedOutlineEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return Array.from(entries);
  const visibleIds = new Set<string>();
  for (const entry of entries) {
    if (!entry.title.toLocaleLowerCase().includes(normalized)) continue;
    const parts = entry.id.split(".");
    for (let index = 1; index <= parts.length; index++) {
      visibleIds.add(parts.slice(0, index).join("."));
    }
  }
  return entries.filter(entry => visibleIds.has(entry.id));
}

function finiteCoordinate(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function viewportPoint(viewport: OutlineViewport, x: number, y: number): [number, number] {
  const point = viewport.convertToViewportPoint(x, y);
  return [finiteCoordinate(point[0], 0), finiteCoordinate(point[1], 0)];
}

/** Return the destination's top-left offset in the currently scaled page viewport. */
export function outlineDestinationOffset(
  destination: readonly unknown[],
  viewport: OutlineViewport,
): { left: number; top: number } {
  const viewBox = viewport.viewBox;
  const leftEdge = finiteCoordinate(viewBox[0], 0);
  const bottomEdge = finiteCoordinate(viewBox[1], 0);
  const rightEdge = finiteCoordinate(viewBox[2], leftEdge);
  const topEdge = finiteCoordinate(viewBox[3], bottomEdge);
  const mode = isRecord(destination[1]) && typeof destination[1].name === "string"
    ? destination[1].name
    : "";
  if (mode === "XYZ") {
    const [left, top] = viewportPoint(
      viewport,
      finiteCoordinate(destination[2], leftEdge),
      finiteCoordinate(destination[3], topEdge),
    );
    return { left: Math.max(0, left), top: Math.max(0, top) };
  }
  if (mode === "FitH" || mode === "FitBH") {
    const y = finiteCoordinate(destination[2], topEdge);
    const [, top] = viewportPoint(viewport, leftEdge, y < 0 ? topEdge : y);
    return { left: 0, top: Math.max(0, top) };
  }
  if (mode === "FitV" || mode === "FitBV") {
    const [left] = viewportPoint(viewport, finiteCoordinate(destination[2], leftEdge), topEdge);
    return { left: Math.max(0, left), top: 0 };
  }
  if (mode === "FitR") {
    const first = viewportPoint(
      viewport,
      finiteCoordinate(destination[2], leftEdge),
      finiteCoordinate(destination[3], bottomEdge),
    );
    const second = viewportPoint(
      viewport,
      finiteCoordinate(destination[4], rightEdge),
      finiteCoordinate(destination[5], topEdge),
    );
    return { left: Math.max(0, Math.min(first[0], second[0])), top: Math.max(0, Math.min(first[1], second[1])) };
  }
  return { left: 0, top: 0 };
}
