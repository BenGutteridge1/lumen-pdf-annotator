# Third-party notices

Lumen PDF Annotator bundles the following runtime dependency:

## PDF.js

- Project: [Mozilla PDF.js](https://github.com/mozilla/pdf.js)
- Distributed package: `pdfjs-dist` 4.10.38
- Copyright: Mozilla Foundation and PDF.js contributors
- License: Apache License 2.0
- License text: [Apache License 2.0](licenses/Apache-2.0.txt)

PDF.js is bundled locally so Lumen can render PDFs without downloading executable code at runtime. Its evaluation-based optimization probes are disabled during the production build to comply with Obsidian's plugin requirements.
