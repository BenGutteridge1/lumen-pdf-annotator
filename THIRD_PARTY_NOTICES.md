# Third-party notices

## Mozilla PDF.js

Lumen PDF Annotator bundles `pdfjs-dist` 4.10.38, the distribution package for
Mozilla PDF.js.

- Project: https://github.com/mozilla/pdf.js
- Copyright: Mozilla and PDF.js contributors
- License: Apache License 2.0
- License text: https://www.apache.org/licenses/LICENSE-2.0

The build disables PDF.js dynamic script loading, Node.js fallback loading, and
runtime code generation before bundling it for the offline Obsidian plugin.
Those build-time changes are documented in `esbuild.config.mjs`.
