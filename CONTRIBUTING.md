# Contributing to Lumen PDF Annotator

Thank you for helping make sustained PDF reading calmer and faster.

## Before opening an issue

- Search existing issues for the same behaviour.
- Confirm the problem still occurs with the current release and a default Obsidian theme.
- Remove unrelated community plugins when checking a compatibility problem.
- Never attach a private, licensed, or personally sensitive PDF. Prefer a small synthetic document or an existing public reproduction.

Bug reports are most useful when they include Obsidian version, operating system, Lumen version, approximate page and annotation counts, reproduction steps, expected result, and a screenshot with private content removed.

## Development

Requirements:

- Node.js 20 or newer
- npm
- A dedicated Obsidian test vault

Install and verify:

```bash
npm ci
npm run typecheck
npm run build
```

For live development, direct output to a test-vault plugin folder:

```bash
LUMEN_PDF_ANNOTATOR_PLUGIN_DIR="/absolute/path/to/Test Vault/.obsidian/plugins/lumen-pdf-annotator" npm run dev
```

Do not point a development build at a production knowledge base. The watch build writes `main.js`, `manifest.json`, and `styles.css` to the configured folder.

## Pull requests

Keep changes focused and explain the user-visible result. A pull request should:

- pass `npm run typecheck` and `npm run build`;
- preserve local-only storage and the original PDF bytes;
- avoid remote code, telemetry, dynamic script loading, and runtime code generation;
- keep rendering and inspector work proportional to visible content;
- include manual QA notes for reader, search, annotation, theme, and persistence changes;
- update README or changelog when behaviour changes.

Performance changes should include a before/after measurement with document size, annotation count, platform, and measurement method. Avoid committing private benchmark fixtures or copyrighted PDFs.

## Release shape

Obsidian releases are tagged with the exact version from `manifest.json`, without a `v` prefix. Each GitHub release contains `main.js`, `manifest.json`, and `styles.css` as individual assets.

## Licence

By contributing, you agree that your contribution is licensed under the repository's MIT License.
