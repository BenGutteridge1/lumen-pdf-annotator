export interface PaletteRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SelectionPageBounds {
  page: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const SELECTION_PALETTE_GAP = 16;
export const SELECTION_PALETTE_MARGIN = 12;

/** The selected text is the anchor, independent of the selection's direction. */
export function selectionPalettePosition(
  selection: PaletteRect,
  bounds: PaletteRect,
  width: number,
  height: number,
): { left: number; top: number; placement: "below" | "above" } {
  const fit = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
  // Clipping the anchor also keeps controls reachable after the selected text
  // scrolls partly or entirely out of view.
  const top = fit(selection.top, bounds.top, bounds.bottom);
  const bottom = fit(selection.bottom, bounds.top, bounds.bottom);
  const left = fit(selection.left, bounds.left, bounds.right);
  const right = fit(selection.right, bounds.left, bounds.right);
  const roomBelow = bounds.bottom - bottom;
  const roomAbove = top - bounds.top;
  const needed = height + SELECTION_PALETTE_GAP;
  // When neither side fits, use the edge with more free space. Clamping then
  // produces the smallest overlap with the visible selection's bounds.
  const placement = roomBelow >= needed ? "below"
    : roomAbove >= needed ? "above"
    : roomBelow >= roomAbove ? "below" : "above";
  return {
    left: fit((left + right - width) / 2, bounds.left, bounds.right - width),
    top: fit(placement === "below" ? bottom + SELECTION_PALETTE_GAP : top - height - SELECTION_PALETTE_GAP,
      bounds.top, bounds.bottom - height),
    placement,
  };
}

/** Binary search cached page bounds; callers only measure the two edge pages. */
export function visibleSelectionPages(
  pages: SelectionPageBounds[],
  top: number,
  bottom: number,
  pageEdge: (page: SelectionPageBounds, edge: "top" | "bottom") => number,
): [SelectionPageBounds, SelectionPageBounds] | null {
  if (!pages.length) return null;
  let low = 0;
  let high = pages.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (pageEdge(pages[middle], "bottom") < top) low = middle + 1;
    else high = middle;
  }
  const first = Math.min(low, pages.length - 1);
  low = first;
  high = pages.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (pageEdge(pages[middle], "top") <= bottom) low = middle + 1;
    else high = middle;
  }
  return [pages[first], pages[Math.max(first, low - 1)]];
}

export const MOBILE_COLOUR_PICKER_WIDTH = 44;
export const MOBILE_COLOUR_PICKER_HEIGHT = 125;
const MOBILE_COLOUR_PICKER_GAP = 8;

/** Keep the column outside the row, even when its alternatives need scrolling. */
export function mobileColourPickerPosition(
  row: PaletteRect,
  swatchCentre: number,
  bounds: PaletteRect,
  rowPlacement: "above" | "below",
): { left: number; top: number; height: number; placement: "above" | "below" } {
  const above = Math.max(0, row.top - bounds.top - MOBILE_COLOUR_PICKER_GAP);
  const below = Math.max(0, bounds.bottom - row.bottom - MOBILE_COLOUR_PICKER_GAP);
  const preferred = rowPlacement === "above" ? above : below;
  const opposite = rowPlacement === "above" ? below : above;
  const placement = preferred >= MOBILE_COLOUR_PICKER_HEIGHT || preferred >= opposite
    ? rowPlacement : rowPlacement === "above" ? "below" : "above";
  const height = Math.min(MOBILE_COLOUR_PICKER_HEIGHT, placement === "above" ? above : below);
  return {
    left: Math.max(bounds.left, Math.min(swatchCentre - MOBILE_COLOUR_PICKER_WIDTH / 2, bounds.right - MOBILE_COLOUR_PICKER_WIDTH)),
    top: placement === "above" ? row.top - MOBILE_COLOUR_PICKER_GAP - height : row.bottom + MOBILE_COLOUR_PICKER_GAP,
    height,
    placement,
  };
}
