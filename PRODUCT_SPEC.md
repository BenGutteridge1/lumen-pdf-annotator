# Lumen PDF Annotator — clean implementation specification

This document is the sole functional specification for the clean rewrite. The
implementation starts from an empty Obsidian plugin and does not inherit source
or Git history from another annotator plugin.

## Product contract

- Desktop Obsidian PDF reader with a quiet, Apple-like floating interface.
- The working PDF is never modified.
- PDF bytes, annotations, journals, and recovery copies remain inside the vault.
- No telemetry, accounts, remote processing, or dynamic code loading.
- Search and annotation panels start closed every time a PDF opens.

## Reader

- Render with one bundled, version-matched PDF.js API and module worker.
- Create page shells for document flow but render only pages near the viewport.
- Destroy canvases and text layers well outside the viewport.
- Cap a rendered canvas at 12 million pixels.
- Collapse exceptionally dense per-page markup into one bounded canvas overlay
  with a spatial click index rather than unbounded mark DOM.
- Provide previous/next page, direct page entry, zoom out/in/reset, and persistent
  light, sepia, and dark document themes.
- Compact controls use Obsidian's accent colour for active state and neutral
  content text.

## PDF search

- `Cmd/Ctrl+F` toggles a floating search panel and focuses its input.
- Search extracted text across the whole PDF, yielding regularly to the UI.
- Results are left aligned and show page, emphasized match, a long excerpt, and
  nearby context. Clicking navigates and briefly flashes the match.
- Search is cancellable. Keep at most 2,000 result records and mount at most 160.

## Annotation creation and editing

- A compact selection palette appears immediately on mouse-up.
- Icon actions select highlight, underline, dashed underline, dotted underline,
  strike-through, box, or comment before five small colour swatches create it.
- A separate icon adds a note to the selected mark type; copy stays one click.
- Marks use normalized page geometry so they survive zoom and resize.
- A sticky-note tool places a page note at the clicked page position.
- Clicking a mark opens its anchored individual editor.
- The editor exposes colour, style, note, comma-separated tags, copy, inspect,
  and delete with the active PDF theme.
- Hover never reveals required controls and native `title` tooltips are omitted.

## Annotation inspector

- A detached right-side panel with search, All/Highlights/Notes filters, colour
  filtering, and newest/page ordering.
- Cards are fixed-height and virtualized with overscan.
- Closing the inspector releases its card DOM; newest/oldest ordering follows
  the mutation-time index without re-sorting the full collection.
- Each card has a bright four-pixel colour edge, page/type metadata, up to three
  visible note lines, and up to three visible quoted-source lines.
- Clicking a result navigates to the mark and expands a full detail editor.
- Empty search text is centred against the complete result frame.

## Persistence and recovery

- SHA-256 of the PDF bytes is the document identity.
- Store under `.lumen-pdf/bundles/sha256/<hash>/`:
  `document.pdf`, `annotations.md`, `annotations.previous.md`,
  `annotations.journal.jsonl`, and `manifest.json`.
- Keep ID and page indexes in memory.
- Append coalesced edits to the journal and checkpoint readable Markdown on
  close/export/explicit flush.
- Preserve a last-known-good Markdown snapshot.
- Export readable annotations, verify every backup checksum, and restore only a
  verified backup to a new recovery path.
- Import compatible user-owned legacy annotations once with stable IDs.

## Performance acceptance

- Hot-path lookup and update are indexed rather than full-array scans.
- Inspector DOM size follows the viewport, not annotation count.
- Search work yields after six pages and can be cancelled.
- Multiple open PDFs have separate workers.
- Target workload: 100,000 annotations, 250,000 ID lookups, 10,000 updates,
  and PDFs with hundreds of pages without long UI stalls.

## Visual tokens

- System UI font; PDF content retains the document's own typography.
- Control height 32 px; icon buttons 28–30 px; swatches 16–18 px.
- Floating surfaces use 12–14 px radii, 1 px Obsidian borders, subtle shadow,
  and theme-native backgrounds.
- Main spacing scale: 4, 6, 8, 12, 16 px.
- Icons are consistent 16 px Lucide-style strokes supplied by Obsidian.
- Motion is 120–180 ms and disabled by `prefers-reduced-motion`.
