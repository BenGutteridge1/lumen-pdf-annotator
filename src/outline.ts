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

function geometryForRange(
  spans: readonly OutlineSearchTextSpan[],
  start: number,
  end: number,
): { geometry: OutlineHeadingGeometry; textHeight: number } | null {
  const matching = spans.filter(span => span.end > start && span.start < end);
  if (!matching.length) return null;
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
  const needle = normalizedTitle(title).toLocaleLowerCase();
  if (!needle) return null;
  const haystack = page.text.toLocaleLowerCase();
  let from = 0;
  let best: { geometry: OutlineHeadingGeometry; textHeight: number } | null = null;
  while (from <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    const end = start + needle.length;
    const startsInsideWord = titleBoundaryCharacter(needle[0]) && titleBoundaryCharacter(haystack[start - 1]);
    const endsInsideWord = titleBoundaryCharacter(needle.at(-1)) && titleBoundaryCharacter(haystack[end]);
    if (!startsInsideWord && !endsInsideWord) {
      const candidate = geometryForRange(page.spans, start, end);
      if (candidate && (!best
        || candidate.textHeight > best.textHeight
        || (candidate.textHeight === best.textHeight && candidate.geometry.topRatio < best.geometry.topRatio))) {
        best = candidate;
      }
    }
    from = start + Math.max(1, needle.length);
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
