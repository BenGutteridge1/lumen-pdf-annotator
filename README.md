# Lumen PDF Annotator

Read, search, highlight, and annotate PDFs inside Obsidian with a calm interface designed to stay out of the document's way.

![Lumen PDF Annotator showing its compact floating toolbar](assets/lumen-reader.jpeg)

Lumen is a desktop-first PDF reader for research-heavy vaults. It combines document themes, contextual full-PDF search, fast text markup, searchable notes, and local recovery files without modifying the source PDF or sending its contents anywhere.

## What it feels like

- A compact floating toolbar with direct page entry, nearby previous/next controls, zoom, search, annotations, and light/sepia/dark themes.
- An immediate selection palette—no hover step—where choosing a colour prepares the mark and choosing its type applies it. Seven mark types are included: highlight, underline, dashed underline, dotted underline, strike-through, box, and comment.
- A floating PDF search that shows long, left-aligned excerpts so results make sense before you open them.
- A virtualized annotation inspector with bright colour edges, readable quotes, notes, and one-click navigation.
- A full editor for each saved mark, including colour, style, note, tags, copy, and delete.
- Right-click any saved highlight to copy a Markdown link that opens its PDF, page, and exact annotation from another note.
- Extend an existing text annotation from its editor; additional selections can be on the same page, a different page, or span a page boundary while remaining one logical annotation.
- Click-to-place page notes, readable exports, checksum verification, and recovery from the local PDF backup.

| Contextual PDF search | Individual annotation editor |
| --- | --- |
| ![Search results with page numbers and surrounding text](assets/lumen-pdf-search.jpeg) | ![Expanded annotation editor with colours, styles, note, and tags](assets/lumen-annotation-editor.jpeg) |

![The virtualized annotation inspector keeps readable cards beside the page](assets/lumen-annotation-inspector.jpeg)

![The compact selection palette appears as soon as text is selected](assets/lumen-selection-toolbar.jpeg)

The screenshots show the running plugin in Obsidian using an original demo document created for this repository.

## Performance by construction

Lumen was built around large documents and dense annotation sets rather than optimized after the fact.

- Only pages near the viewport receive a canvas and selectable text layer; distant pages remain lightweight shells.
- Canvas rendering is capped at 12 million pixels to avoid runaway memory use at extreme zoom levels.
- Annotation lookups use ID and page indexes, so drawing a page does not scan the entire collection.
- Pages with unusually dense markup switch to one bounded canvas overlay with a spatial click index instead of creating thousands of DOM nodes.
- The inspector mounts only the visible card window plus overscan.
- Full-document search yields to Obsidian every six pages, can be cancelled, and bounds retained results and mounted cards.
- Selection capture and current-page tracking use page-range/binary lookup rather than walking every page, while hidden search and inspector panels release their result DOM.
- Snapshot restore, annotation journals, and checkpoint serialization yield in bounded batches so six-figure loads and saves do not monopolize the UI thread.
- Each open PDF receives its own bundled, version-matched PDF.js worker.

A private synthetic benchmark used during development inserted and search-indexed 100,000 annotations across 1,000 pages in 90.15 ms, traversed every page bucket in 9.17 ms, and searched all annotations in 13.28 ms on the development machine. A separate extreme run indexed 250,000 annotations across 2,000 pages in 253.49 ms, applied 10,000 edits in 22.91 ms, traversed the page buckets in 23.11 ms, filtered the full collection in 40.27 ms, and sorted it in 8.54 ms. Those figures describe the in-memory index. After cooperative restore yielding was enabled, a separate 100,000-record storage run parsed and search-indexed the snapshot in 467.15 ms total while returning to the host between 1,000-record batches, then produced a 35.2 MB readable checkpoint in 555.98 ms.

The production bundle was also exercised inside Obsidian 1.13.7 with a 455-page PDF and 100,000 temporary annotations. In that run the annotations were inserted in 106.5 ms, the inspector opened in 2.9 ms, only nine annotation cards were mounted, and its capped virtual scroller navigated correctly from the newest record through the midpoint to the end. The temporary records were never queued for persistence and were removed after the run. Results vary by machine and document, but the numbers make the intended scale concrete.

## Local, readable storage

The source PDF is never edited. Lumen hashes its bytes with SHA-256 and stores a recoverable bundle in your vault:

```text
.lumen-pdf/
  bundles/
    sha256/
      <document-hash>/
        document.pdf
        manifest.json
        annotations.md
        annotations.previous.md
        annotations.journal.jsonl
```

`annotations.md` is a human-readable snapshot. The append-only JSONL journal protects recent changes between checkpoints, while `annotations.previous.md` preserves the last known-good snapshot. Because identity comes from PDF content, annotations remain associated when the original file is renamed or moved.

Everything stays in the vault: no account, telemetry, remote processing, CDN scripts, or dynamic code loading.

## Install

### Obsidian Community Plugins

Once Lumen is accepted into the community directory:

1. Open **Settings → Community plugins → Browse**.
2. Search for **Lumen PDF Annotator**.
3. Select **Install**, then **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create `<your-vault>/.obsidian/plugins/lumen-pdf-annotator/`.
3. Place all three files in that folder.
4. Reload Obsidian, then enable **Lumen PDF Annotator** under Community plugins.

Lumen currently supports desktop Obsidian 1.13.7 or newer.

## Use

Open any PDF after enabling Lumen. The PDF search and annotation inspector begin closed every time a document opens.

Select text to open the compact markup palette. Choose a colour first, then choose a mark type to apply it immediately—there is no separate confirmation step. Choosing the comment type also opens the individual editor so you can add its note. Nothing is saved merely by choosing a swatch. Click an existing mark or its inspector card to open the individual editor. Use the sticky-note icon or **Place a page note** command to place a note anywhere on a page. PDF search marks every exact match on the rendered page and strengthens the selected result. The toolbar's theme controls affect the reading surface and editor together; the chosen theme persists and Lumen button text and icons follow your Obsidian accent colour in every PDF theme.

Right-click a saved mark and choose **Copy link to highlight**. Paste the resulting Markdown link into any note in the same vault; following it opens the PDF in a new tab, scrolls to the linked annotation, flashes it, and opens its editor. To add more text to a saved annotation, open its editor and use the scan-text icon. Navigate if needed, select the additional text, and confirm the floating **Extend annotation** action. Cross-page segments share colour, style, note, tags, link target, inspector card, and deletion as one annotation.

Default hotkeys:

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Toggle PDF search | `Cmd+F` | `Ctrl+F` |
| Toggle annotation inspector | `Cmd+Shift+A` | `Ctrl+Shift+A` |
| Zoom in | `Cmd+Shift+=` | `Ctrl+Shift+=` |
| Zoom out | `Cmd+-` | `Ctrl+-` |
| Reset zoom | `Cmd+0` | `Ctrl+0` |

Previous page, next page, page-note placement, annotation checkpoint, export, legacy import, backup verification, recovery, and **Open current PDF in Lumen annotator** are also available in Obsidian's command palette and can be assigned custom hotkeys.

### Backup, export, and migration commands

- **Export annotations for this PDF** writes a readable Markdown file under `.lumen-pdf/exports/`.
- **Save an annotation checkpoint** immediately compacts the journal into a snapshot.
- **Verify all PDF backup checksums** checks every local backup against its SHA-256 identity.
- **Restore a backed-up PDF** verifies the checksum before creating a non-destructive copy under `.lumen-pdf/recovered/`.
- **Import legacy annotations for this PDF** imports compatible user-owned annotation data when present. Automatic migration is attempted once per document and uses stable IDs to prevent duplicates.

## Settings

**Make Lumen the default PDF viewer** is enabled initially. Disable it if you want to keep Obsidian's built-in PDF view and open selected PDFs through Lumen's command instead. Restart Obsidian after changing this setting. **PDF theme** sets the persistent light, sepia, or dark reading theme.

## Contributing

Issues, feature requests, pull requests, forks, and independent builds are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and project boundaries.

```bash
npm ci
npm run typecheck
npm run build
```

The production build is written to `dist/`. For a live development build, set `LUMEN_PDF_ANNOTATOR_PLUGIN_DIR` to a dedicated test-vault plugin directory and run `npm run dev`.

## Scope and roadmap

The first public release is desktop-only. Planned work includes additional portable export formats, accessibility refinement, and performance profiling across a wider range of scanned and malformed PDFs.

Please report a reproducible document issue through the bug template. Do not upload a private PDF; use a minimal public or synthetic reproduction whenever possible.

## Clean-room note

Lumen is an independent rewrite from a standalone product specification. Zotero and Alex Annotator helped identify useful interaction concepts in the broader PDF-annotation space, but no source code, assets, styles, or Git history from either project are included. The compatibility importer only reads user-owned annotation data; the interface, current storage format, performance architecture, and implementation are Lumen's own.

## License

[MIT](LICENSE) © 2026 Ben Gutteridge. Bundled dependency notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
