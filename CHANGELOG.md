# Changelog

All notable changes to Lumen PDF Annotator are documented here.

## 1.0.10 — 2026-08-29

- Replaced stylesheet priority flags with scoped, higher-specificity equivalents while preserving every existing visual value and interaction state.
- Removed the final source-code review warning without changing the bounded PDF search-cache eviction behavior.
- Kept PDF.js network and base64 capabilities intact because stripping them could break valid documents; Lumen continues to load PDF bytes locally with auto-fetch and worker fetch disabled.

## 1.0.9 — 2026-08-28

- Added official ESLint tooling, PDF.js declarations, safer data normalization, and typed view-state restoration while preserving the existing runtime behavior and UI.
- Added declarative settings definitions for Obsidian settings search without changing the four existing settings, controls, or their appearance.
- Limited future release artifacts to `main.js`, `manifest.json`, and `styles.css`, with GitHub provenance attestations for the JavaScript and CSS artifacts.
- Made no runtime feature, performance architecture, or CSS changes in this review release.

## 1.0.8 — 2026-08-25

- Added an opaque, content-sized selected-text preview beneath the floating extension confirmation; only its text is muted, and long quotes wrap and grow vertically within a bounded surface.
- Supplied PDF.js's required text-layer scale factor so caret hit-testing, quote extraction, selection geometry, and extension previews remain aligned across zoom levels.
- Replaced proportional-character estimates with exact rendered text-range geometry for Find in PDF marks on visible pages, keeping the lightweight whole-document index for large-file performance.
- Centred short extension-preview surfaces beneath their confirmation controls while preserving content-sized growth for longer selections.
- Preserved narrow and zero-width PDF.js glyph-boundary rectangles when capturing selections, then safely coalesced adjacent fragments so punctuation remains part of the visible mark.
- Retained the page and zoom restoration introduced in 1.0.7 while correcting release metadata for both versions.

## 1.0.7 — 2026-08-25

- Remembered the last page and zoom level for each PDF and restored them when the document reopens.

## 1.0.6 — 2026-08-24

- Paused new page rendering during active scrolling and cancelled stale canvas and text-layer work as soon as a page leaves the render window.
- Replaced the FIFO page renderer with a direction-aware, visible-page-priority queue limited to one canvas job at a time.
- Added a low-resolution preview after scrolling settles, followed by an idle high-detail canvas and selectable text layer without replacing a ready canvas prematurely.
- Yielded PDF.js render continuations to animation frames so long page paints do not monopolize the interface thread.
- Reduced dense-mark DOM pressure, paced dense canvas overlays during scrolling, and delegated annotation pointer events from one page-container listener.
- Released canvas backing stores and PDF page resources during unmount, zoom, and teardown.
- Verified rapid forward and reverse scrolling in Obsidian with a synthetic 3,000-page PDF: no sampled frame exceeded 34 ms, with a worst sampled gap of 33 ms.

## 1.0.5 — 2026-08-24

- Removed the automatic vault-wide legacy-note scan from PDF open; legacy import is now an explicit command.
- Replaced eager per-page canvases, text layers, annotation layers, and listeners with batched lightweight page shells and delegated events.
- Limited normal viewport rendering to two concurrent page mounts and fixed off-screen teardown so canvases, PDF page proxies, text layers, render tasks, and hit indexes are actually released.
- Added a direct windowed recency index for the default annotation inspector, keeping visible-card lookup within a frame at 250,000 annotations.
- Added bounded least-recently-used PDF search text caching and cleanup of non-visible page resources.
- Added stable file metadata caching so unchanged PDFs are not re-hashed on every open.
- Made full PDF recovery copies optional, disabled them by default, and moved enabled copies off the document-open critical path.
- Replaced automatic close-time Markdown snapshot rebuilds with bounded journal flushes and faster compact JSON checkpoints.
- Added fallback from corrupt compact snapshots through the previous snapshot and legacy Markdown recovery data.
- Removed per-page zoom layout animations that scaled poorly with documents containing thousands of pages.
- Fixed the expanded inspector detail remaining open after its annotation was deleted.
- Verified the production bundle with a synthetic 3,000-page PDF, rare-match full-document search, rapid distant-page navigation, and 100,000/250,000-annotation workloads.

## 1.0.0 — 2026-08-23

- Initial public release.
- Added near-viewport PDF rendering with bounded canvas memory.
- Added direct page navigation, compact zoom controls, and light, sepia, and dark themes.
- Kept the selected PDF theme across Obsidian restarts and preserved the vault accent colour on plugin buttons across every PDF theme.
- Added cancellable contextual full-PDF search.
- Added highlight, underline, dashed underline, dotted underline, strike-through, box, comment, colour, note, tag, copy, and delete workflows.
- Changed the selection palette so colour and mark type can be chosen independently before an explicit Apply or Apply-and-note action; colour swatches remain visible on hover.
- Added exact on-page highlighting for PDF search matches, with a stronger marker for the opened result.
- Added right-click Markdown links that reopen and reveal an exact saved highlight.
- Added post-creation annotation extension on the same page or across PDF pages, stored as page-indexed segments under one logical annotation.
- Added click-to-place page notes and persistent PDF themes.
- Added a virtualized annotation inspector and individual annotation editor.
- Added inspector colour filters and newest, oldest, or page ordering.
- Added indexed annotation search, mutation-order sorting, dense-page canvas fallback, spatial mark hit-testing, and cooperatively yielded restore/journal/checkpoint work for six-figure workloads.
- Added local SHA-256 document bundles with Markdown snapshots, a recovery copy, an append-only journal, export, verification, restore, and compatible legacy import.
