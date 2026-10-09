# Third-party notices

Lumen PDF Annotator bundles the following runtime dependency:

## PDF.js

- Project: [Mozilla PDF.js](https://github.com/mozilla/pdf.js)
- Distributed package: `pdfjs-dist` 4.10.38
- Copyright: Mozilla Foundation and PDF.js contributors
- License: Apache License 2.0
- License text: [Apache License 2.0](licenses/Apache-2.0.txt)

PDF.js is bundled locally so Lumen can render PDFs without downloading executable code at runtime. Its evaluation-based optimization probes are disabled during the production build to comply with Obsidian's plugin requirements.

Lumen's build also applies a local, version-checked modification to the PDF.js 4.10.38 worker. It reads the standard glyph names already parsed from validated embedded TrueType `post` tables, retains a bounded fallback for missing/NUL Unicode mappings, and applies it only during text extraction. Rendering mappings, glyph widths and painted glyphs remain unchanged. Repaired text items carry an additive flag for annotation offset compatibility. The patch and portable promise helper are in `build/pdfjs-worker.mjs`; upgrades require reviewing its checked source locations. PDF.js's Apache-2.0 notice remains in the bundled worker.
