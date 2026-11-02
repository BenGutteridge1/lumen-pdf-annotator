// Build a local browser integration harness; no Obsidian vault is touched.
// node test/browser-mobile-harness.mjs [output-directory]
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildPdfWorker, portablePromises, PDFJS_VERSION } from '../build/pdfjs-worker.mjs';
const require = createRequire(import.meta.url);
const output = path.resolve(process.argv[2] ?? '../mobile-harness');
fs.mkdirSync(output, { recursive: true });
await build({
  stdin: { contents: `import { LumenPdfView } from './src/view';
    import { PdfViewStateManager } from './src/view-state';
    import { ReadingPositionStore } from './src/reading-position';
    import { Platform, TFile } from 'obsidian';
    window.LumenHarness = { LumenPdfView, PdfViewStateManager, ReadingPositionStore, Platform, TFile };`,
    resolveDir: process.cwd(), loader: 'ts' },
  outfile: path.join(output, 'harness.js'), bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
  plugins: [{ name: 'harness-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'host' }));
    builder.onLoad({ filter: /.*/, namespace: 'host' }, () => ({ loader: 'js', contents: `
      export const Platform = { isMobile: false };
      export class FileView {
        constructor(leaf) { Object.assign(this, leaf); this.cleanups = []; }
        register(fn) { this.cleanups.push(fn); }
        registerDomEvent(target, name, listener, options) { target.addEventListener(name, listener, options); this.register(() => target.removeEventListener(name, listener, options)); }
      }
      export class Scope { register() {} }
      export class Plugin {}
      export class TFile { constructor(path, size = 0) { this.path = path; this.name = path.split('/').at(-1); this.basename = this.name.replace(/\\.pdf$/i, ''); this.extension = 'pdf'; this.stat = { mtime: 1, size }; } }
      export class Notice { constructor(text) { console.info('Notice:', text); } }
      export class Menu { addItem(fn) { fn({ setTitle() { return this; }, setIcon() { return this; }, setChecked() { return this; }, onClick() { return this; } }); return this; } showAtPosition() {} }
      export const normalizePath = value => value;
      const toolbarIcons = {
        'chevron-up': '<path d="m18 15-6-6-6 6"/>',
        'chevron-left': '<path d="m15 18-6-6 6-6"/>',
        'chevron-right': '<path d="m9 18 6-6-6-6"/>',
        minus: '<path d="M5 12h14"/>', plus: '<path d="M12 5v14M5 12h14"/>',
        search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
        'messages-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        'sticky-note': '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11l5-5V5a2 2 0 0 0-2-2zM16 21v-5h5"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
        moon: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>',
        coffee: '<path d="M18 8h1a4 4 0 0 1 0 8h-1M3 8h15v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4ZM6 1v3m4-3v3m4-3v3"/>',
        x: '<path d="m18 6-12 12M6 6l12 12"/>',
      };
      export const setIcon = (element, name) => { element.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (toolbarIcons[name] ?? '<circle cx="12" cy="12" r="6"/>') + '</svg>'; element.dataset.icon = name; };
    ` }));
    builder.onResolve({ filter: /^lumen-pdf-worker$/ }, () => ({ path: require.resolve('pdfjs-dist/build/pdf.worker.mjs'), namespace: 'worker' }));
    builder.onLoad({ filter: /.*/, namespace: 'worker' }, args => ({ loader: 'text', contents: buildPdfWorker(fs.readFileSync(args.path, 'utf8'), PDFJS_VERSION) }));
    builder.onLoad({ filter: /pdfjs-dist[/\\]build[/\\]pdf\.mjs$/ }, args => ({ loader: 'js', contents: portablePromises(fs.readFileSync(args.path, 'utf8').replace(
      'function isEvalSupported() {\n  try {\n    new Function("");\n    return true;\n  } catch {\n    return false;\n  }\n}',
      'function isEvalSupported() { return false; }'), args.path) }));
  } }],
});
fs.copyFileSync('test/browser-mobile-harness.html', path.join(output, 'index.html'));
fs.copyFileSync('styles.css', path.join(output, 'styles.css'));
console.log(`Browser harness built at ${output}`);
