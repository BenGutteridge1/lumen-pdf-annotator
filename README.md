<h1 align="center">Lumen PDF Annotator</h1>

<p align="center">
  A fast, local-first PDF reader and annotator for Obsidian.
</p>

<p align="center">
  <a href="https://github.com/BenGutteridge1/lumen-pdf-annotator/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/BenGutteridge1/lumen-pdf-annotator?label=release"></a>
  <a href="https://github.com/BenGutteridge1/lumen-pdf-annotator/actions/workflows/release.yml"><img alt="Release build" src="https://github.com/BenGutteridge1/lumen-pdf-annotator/actions/workflows/release.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Desktop only" src="https://img.shields.io/badge/Obsidian-desktop%20only-7c3aed">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#reader-and-annotation-features">Features</a> ·
  <a href="#performance-architecture">Performance</a> ·
  <a href="#storage-and-recovery">Storage</a> ·
  <a href="https://github.com/BenGutteridge1/lumen-pdf-annotator/issues">Report a problem</a>
</p>

Lumen provides a clean, floating interface for searching PDFs, marking passages,
and writing notes without leaving Obsidian. PDFs, annotations, journals, and
recovery copies remain local to the vault; the plugin has no telemetry and does
not require an account or remote service.

> [!NOTE]
> Lumen is a desktop-only plugin for Obsidian 1.13.7 or newer. Its Community
> Plugins listing is pending; the latest GitHub release can be installed
> manually or through BRAT in the meantime.

## Why Lumen

- **Responsive with large libraries.** Page rendering is viewport-aware and the
  annotation list is indexed and virtualized instead of mounting every result.
- **Made for close reading.** Search, themes, highlights, notes, tags, and
  individual mark editing stay beside the document in compact floating panels.
- **Readable, recoverable data.** Notes are checkpointed to Markdown and recent
  changes are protected by a local append-only journal.
- **Safe original files.** Lumen never writes annotations into the working PDF.
  A checksum-addressed recovery copy protects against moves, replacements, and
  accidental deletion.

## Quick start

1. Install Lumen using one of the methods under [Installation](#installation).
2. Open a PDF and run **Open current PDF in Lumen annotator** from the command
   palette, or enable **Make Lumen the default PDF viewer** in Lumen settings.
3. Select text. The floating palette appears immediately; choose a colour or a
   mark style, or open the note action.
4. Click an existing mark to edit its note, tags, colour, or style.
5. Use `Cmd/Ctrl+F` to search the PDF and `Cmd/Ctrl+Shift+A` to open the
   searchable annotation inspector.

## Reader and annotation features

- Light, sepia, and dark PDF themes.
- Highlight, underline, strike-through, and box annotation styles.
- Floating selection tools appear immediately after text selection; five pastel
  colour actions create a highlight in one click, while the style tray, note,
  copy, and dismiss actions remain compact, flat, and icon-led.
- Click any existing mark to open its anchored editor.
- Per-mark colour, style, note, comma-separated tags, copy, inspect, and delete.
- A floating, searchable annotation rail with All, Highlights, and Notes filters.
- Richer virtualized annotation cards with page/type metadata, a brighter
  colour-coded edge, neutral primary note text, and three visible lines each
  for note and quoted source context when content is available.
- Compact icon-led toolbar with grouped page and zoom controls; active controls
  follow Obsidian's configured accent colour.
- Theme-aware inspector and anchored editor built from the same icon controls.
- Full-document PDF search from the floating toolbar or `Cmd+F`.
- Incremental, left-aligned search results with page, match type, a longer
  primary excerpt, wider nearby context, and exact-term emphasis; clicking a
  result navigates and flashes the match on the page. Closing search immediately
  clears its transient PDF hit layer.
- Clicking an annotation opens a full inspector for source text, note, tags,
  colour, and mark style. The source block can expand to reveal the complete
  captured passage.
- Page navigation and zoom controls.

## Keyboard shortcuts

All actions are exposed in **Settings → Hotkeys**. The built-in defaults use one
early capture router so each chord executes exactly once. `Cmd/Ctrl+F` can also
override Obsidian from outside the PDF:

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Toggle PDF search | `Cmd+F` | `Ctrl+F` |
| Toggle annotation inspector | `Cmd+Shift+A` | `Ctrl+Shift+A` |
| Zoom in | `Cmd++` / `Cmd+=` | `Ctrl++` / `Ctrl+=` |
| Zoom out | `Cmd+-` | `Ctrl+-` |
| Reset zoom | `Cmd+0` | `Ctrl+0` |

**Previous PDF page**, **Next PDF page**, and **Toggle page-note placement** are
available as assignable commands without default chords. Directional and Option
key combinations are left to the user because desktop/Obsidian bindings can
swallow them. If a Lumen PDF is open, `Cmd/Ctrl+F` activates the active or most
recently used Lumen reader and toggles its floating search even when focus is
elsewhere in Obsidian.

Enable **Make Lumen the default PDF viewer** in plugin settings to redirect
ordinary PDF clicks to the Lumen view. The command palette action **Open current
PDF in Lumen annotator** remains available as an explicit route.

## Performance architecture

Lumen is designed for large PDFs and large annotation libraries:

- PDF pages are rendered only near the viewport with `IntersectionObserver`.
- Off-screen canvases and text layers are destroyed to release memory.
- Rendered canvas size is capped at 12 million pixels per page.
- The annotation store maintains ID and page indexes for constant-time hot-path
  lookup instead of rescanning every annotation.
- The annotation rail uses fixed-height windowing with overscan, so the DOM size
  follows the viewport rather than the total annotation count.
- Annotation changes are coalesced into an append-only journal; the readable
  Markdown snapshot is checkpointed on close, export, or explicit flush.
- Full-PDF search is cancellable and yields to the UI every six pages.
- Search results shown in the DOM are capped while the total count continues to
  be tracked.

Release validation exercises 50,000 annotations, 250,000 indexed ID lookups,
and 10,000 updates. On the development machine, those indexed operations
complete in tens of milliseconds rather than scaling with the mounted UI.

## Storage and recovery

PDF identity is derived from a SHA-256 hash of its bytes. Canonical vault-local
data is stored under:

```text
.pdf-annotator/bundles/sha256/<hash>/
  document.pdf
  annotations.md
  annotations.previous.md
  annotations.journal.jsonl
  manifest.json
```

`document.pdf` is a verified byte-for-byte recovery copy. `annotations.md` is a
human-readable snapshot with a fenced JSON source of truth. The journal protects
recent edits without forcing a full snapshot rewrite for every keystroke.

Renaming or moving the working PDF does not move its identity bundle. Replacing
a file with different bytes creates a new bundle, preventing annotations from
silently attaching to a different document. Commands are included to verify all
managed backups, restore a deleted or damaged working PDF, export annotations,
and import legacy sidecars.

## Privacy

Lumen has no telemetry and sends neither PDF content nor annotation content to
remote services. All data stays inside the Obsidian vault.

## Support and known limits

- Lumen is desktop-only; mobile Obsidian is not supported.
- Image-only or scanned PDFs need OCR before text selection and search can work.
- The verified recovery bundle stores another copy of each annotated PDF, so it
  uses approximately one additional PDF's worth of vault storage.
- Search keeps at most 2,000 result records and mounts at most 160 cards. The
  total match count remains accurate.
- Report reproducible problems through [GitHub Issues](https://github.com/BenGutteridge1/lumen-pdf-annotator/issues).
  Please do not attach private PDFs, vault data, or annotation content.

## Installation

### Community Plugins

Lumen is being prepared for the Obsidian Community Plugins directory. Until
the listing is approved, install the latest GitHub release manually or with
[BRAT](https://github.com/TfTHacker/obsidian42-brat) using this repository URL.

```text
https://github.com/BenGutteridge1/lumen-pdf-annotator
```

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the release matching
the version in `manifest.json`. Place them in:

```text
<vault>/.obsidian/plugins/lumen-pdf-annotator/
```

Restart Obsidian, then enable **Lumen PDF Annotator** under **Settings →
Community plugins**.

## Development

```bash
npm ci
npm run typecheck
npm run build
```

The production build is written to `dist/`. Set
`LUMEN_PDF_ANNOTATOR_PLUGIN_DIR` only when you intentionally want the build
script to copy release files to a specific local plugin directory.

## Release files

An Obsidian release contains:

```text
main.js
manifest.json
styles.css
```

## Attribution and provenance

Lumen PDF Annotator is a substantially redesigned derivative of
[Alex Annotator](https://github.com/alexandert142/Alex-annotator) by Alexander
Tian, used under its MIT license. Lumen retains that copyright notice in
`LICENSE` and adds a new floating interface, indexed/virtualized annotation
paths, large-document search, backup bundles, themes, hotkeys, and extensive
performance work and regression validation.

The production bundle embeds Mozilla PDF.js through `pdfjs-dist`. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for its Apache-2.0 notice.

Community Directory publication is subject to Obsidian's fork policy and the
original author's publicly verifiable approval.
