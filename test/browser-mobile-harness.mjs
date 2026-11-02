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
    import { LumenSettingTab } from './src/main';
    import { Platform, TFile } from 'obsidian';
    window.LumenHarness = { LumenPdfView, PdfViewStateManager, ReadingPositionStore, LumenSettingTab, Platform, TFile };`,
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
      export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
      export class Modal {}
      export class FuzzySuggestModal {}
      export class TFolder {}
      export class TFile { constructor(path, size = 0) { this.path = path; this.name = path.split('/').at(-1); this.basename = this.name.replace(/\\.pdf$/i, ''); this.extension = 'pdf'; this.stat = { mtime: 1, size }; } }
      export class Notice { constructor(text) { console.info('Notice:', text); } }
      export class Menu { addItem(fn) { fn({ setTitle() { return this; }, setIcon() { return this; }, setChecked() { return this; }, onClick() { return this; } }); return this; } showAtPosition() {} }
      export const normalizePath = value => value;
      // SVG geometry from the bundled Lucide registry in Obsidian 1.14.5.
      // License notices: licenses/LUCIDE-LICENSE.txt (Lucide ISC / Feather MIT).
      const toolbarIcons = {
        'chevron-up': '<path d="m18 15-6-6-6 6"/>',
        'chevron-left': '<path d="m15 18-6-6 6-6"/>',
        'chevron-right': '<path d="m9 18 6-6-6-6"/>',
        minus: '<path d="M5 12h14"/>',
        plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
        search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
        'list-tree': '<path d="M8 5h13"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="M3 10a2 2 0 0 0 2 2h3"/><path d="M3 5v12a2 2 0 0 0 2 2h3"/>',
        'messages-square': '<path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"/>',
        'sticky-note': '<path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><path d="M15 3v5a1 1 0 0 0 1 1h5"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
        moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
        coffee: '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>',
        x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
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
