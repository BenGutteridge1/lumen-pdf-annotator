# Changelog

All notable changes to Lumen PDF Annotator are documented here.

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
