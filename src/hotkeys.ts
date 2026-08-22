export interface ModFLikeEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

export type PdfHotkeyAction =
  | "toggle-search"
  | "toggle-inspector"
  | "zoom-in"
  | "zoom-out"
  | "reset-zoom";

/** Resolve the small set of built-in reader accelerators at the window capture
 * phase. Keeping them on one route avoids duplicate execution when Obsidian
 * also sees the same Electron key event. */
export function pdfHotkeyAction(event: ModFLikeEvent): PdfHotkeyAction | null {
  if (event.repeat || (!event.metaKey && !event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (!event.shiftKey && key === "f") return "toggle-search";
  if (event.shiftKey && key === "a") return "toggle-inspector";
  // On many layouts "+" is Shift+"="; accept both the shifted and
  // unshifted forms while keeping unrelated shifted chords available.
  if (event.shiftKey && (event.key === "+" || key === "=")) return "zoom-in";
  if (event.shiftKey) return null;
  if (event.key === "+" || event.key === "=") return "zoom-in";
  if (event.key === "-" || event.key === "_") return "zoom-out";
  if (event.key === "0") return "reset-zoom";
  return null;
}

/** Exact cross-platform PDF-search accelerator. Repeats are ignored so holding
 * the keys cannot rapidly open and close the floating search panel. */
export function isPdfSearchToggleHotkey(event: ModFLikeEvent): boolean {
  return pdfHotkeyAction(event) === "toggle-search";
}

/** Prefer the active reader, then the last reader the user worked in, then the
 * first still-open reader. Stale recent leaves are intentionally ignored. */
export function pickPdfHotkeyTarget<T>(
  active: T | null,
  recent: T | null,
  open: readonly T[]
): T | null {
  if (active && open.includes(active)) return active;
  if (recent && open.includes(recent)) return recent;
  return open[0] ?? null;
}
