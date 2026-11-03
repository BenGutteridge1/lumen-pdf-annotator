import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

async function bundle(entry, mobile = false) {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
    plugins: [{ name: 'palette-test-host', setup(builder) {
      builder.onResolve({ filter: /^obsidian$|^\.\/pdf-runtime$|^pdfjs-dist\/build\/pdf\.mjs$/ }, args => ({ path: args.path, namespace: 'palette-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'palette-test' }, args => ({ loader: 'js', contents: args.path === 'obsidian' ? `
        export const Platform = { isMobile: ${mobile} };
        export class FileView { constructor(leaf) { Object.assign(this, leaf); } }
        export class Scope { register() {} }
        export class Menu {} export class Notice {} export class TFile {} export class Plugin {}
        export const normalizePath = value => value; export const setIcon = () => {};
      ` : args.path === './pdf-runtime' ? 'export const loadPdf = () => { throw Error("Not a PDF fixture"); };'
        : 'export class TextLayer {}' }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const { selectionPalettePosition: position, visibleSelectionPages } = await bundle('src/selection-palette.ts');
const { LumenPdfView } = await bundle('src/view.ts');
const { LumenPdfView: MobilePdfView } = await bundle('src/view.ts', true);
const bounds = { left: 112, top: 142, right: 988, bottom: 768 };
const text = { left: 300, top: 400, right: 700, bottom: 500 };

test('selection palette prefers a 16px gap below even when there is more space above', () => {
  assert.deepEqual(position(text, bounds, 450, 50), { left: 275, top: 516, placement: 'below' });
  assert.equal(position({ ...text, top: 650, bottom: 700 }, bounds, 450, 50).placement, 'below');
});
test('selection palette flips above and changes back below as available space changes', () => {
  assert.deepEqual(position(text, { ...bounds, bottom: 550 }, 450, 50), { left: 275, top: 334, placement: 'above' });
  assert.equal(position(text, { ...bounds, bottom: 566 }, 450, 50).placement, 'below', 'the full gap and actual palette height fit exactly');
  assert.equal(position({ ...text, top: 160, bottom: 260 }, { ...bounds, bottom: 550 }, 450, 50).placement, 'below');
});
test('large/multiline selections use the edge with least overlap and keep controls in bounds', () => {
  assert.deepEqual(position({ ...text, top: 160, bottom: 750 }, bounds, 450, 90), { left: 275, top: 678, placement: 'below' });
  assert.deepEqual(position({ ...text, top: 190, bottom: 760 }, bounds, 450, 90), { left: 275, top: 142, placement: 'above' });
  assert.equal(position({ ...text, top: -100, bottom: 190 }, bounds, 450, 50).top, 206);
  assert.equal(position({ ...text, top: 800, bottom: 1000 }, bounds, 450, 50).top, 702);
});
test('horizontal geometry stays inside narrow panes and clipped selections', () => {
  assert.equal(position({ ...text, left: -200, right: 200 }, bounds, 450, 50).left, 112);
  assert.equal(position({ ...text, left: 950, right: 1400 }, bounds, 450, 50).left, 538);
  const small = { left: 20, top: 20, right: 240, bottom: 180 };
  const placed = position(text, small, 220, 90);
  assert.equal(placed.left, 20); assert.ok(placed.top >= 20 && placed.top + 90 <= 180);
});
test('multipage selection lookup is logarithmic and returns the visible edge pages', () => {
  const pages = Array.from({ length: 100000 }, (_, i) => ({ page: i + 1, top: .1, bottom: .9 }));
  let reads = 0;
  const edge = (page, key) => { reads++; return (page.page - 1) * 1000 + page[key] * 1000; };
  assert.deepEqual(visibleSelectionPages(pages, 50000100, 50002800, edge).map(page => page.page), [50001, 50003]);
  assert.ok(reads <= 34, `only ${reads} offset reads across 100,000 selected pages`);
  assert.deepEqual(visibleSelectionPages(pages, -2000, -1000, edge).map(page => page.page), [1, 1]);
  assert.deepEqual(visibleSelectionPages(pages, 100000001, 100001000, edge).map(page => page.page), [100000, 100000]);
  assert.equal(visibleSelectionPages([], 0, 100, edge), null);
});

function fixture(View = LumenPdfView) {
  const frames = new Map(); let frameId = 0, nativeSelection = null;
  const owner = new EventTarget(); Object.assign(owner, { innerWidth: 1200, innerHeight: 900,
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id), getSelection: () => nativeSelection });
  const doc = new EventTarget(); doc.defaultView = owner;
  const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
  const scroll = new EventTarget(); Object.assign(scroll, { scrollTop: 0, clientWidth: 900, clientHeight: 700,
    getBoundingClientRect: () => rect(100, 80, 900, scroll.clientHeight) });
  const root = { getBoundingClientRect: () => rect(100, 80, 900, scroll.clientHeight) };
  let pageReads = 0, rangeReads = 0, removed = false;
  const shell = { offsetTop: 20, offsetHeight: 1000, getBoundingClientRect: () => {
    pageReads++; return rect(200, 100 - scroll.scrollTop, 700, 1000);
  } };
  const classes = new Set();
  const palette = { style: {}, dataset: {}, classList: { add(name) { classes.add(name); }, contains: name => classes.has(name) },
    getBoundingClientRect: () => rect(0, 0, Math.min(450, parseFloat(palette.style.maxWidth) || 450), 50),
    remove() { removed = true; } };
  const view = new View({ app: { scope: {} }, containerEl: { ownerDocument: doc } });
  Object.assign(view, { rootEl: root, scrollEl: scroll, toolbarEl: { getBoundingClientRect: () => rect(300, 92, 500, 38) },
    pagesEl: { contains: () => true }, selectionPalette: palette,
    selection: { quote: 'selected text', x: 1, y: 1, nativeRange: { getClientRects() { rangeReads++; throw Error('must use cached geometry'); } },
      paletteBounds: [{ page: 1, left: 1 / 7, right: 5 / 7, top: .3, bottom: .4 }] } });
  view.pages.set(1, { shell });
  const observers = [];
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; this.observed = []; observers.push(this); }
    observe(target) { this.observed.push(target); } disconnect() { this.disconnected = true; } };
  // The active desktop palette must use its owning window, never the main app window.
  globalThis.window = { innerWidth: 1, innerHeight: 1, getSelection: () => { throw Error('wrong window'); } };
  const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  return { view, owner, doc, scroll, palette, frames, frame, observers, counts: () => ({ pageReads, rangeReads, removed }),
    setNative: value => { nativeSelection = value; } };
}
test('desktop uses owning-window text geometry regardless of pointer release direction', () => {
  const { view, palette } = fixture();
  view.positionSelectionPalette();
  const forward = { ...palette.style };
  view.selection.x = 900; view.selection.y = 20;
  view.positionSelectionPalette();
  assert.deepEqual(palette.style, forward);
  assert.equal(palette.style.top, '516px'); assert.equal(palette.dataset.placement, 'below');
});
test('selection and extension palettes are created in their reader document, never the main window body', () => {
  const item = fixture(); const created = [];
  const widget = () => ({ style: { setProperty() {} }, dataset: {}, classList: { toggle() {} },
    setAttribute() {}, addEventListener() {}, append() {}, remove() {},
    createDiv: () => widget(), createSpan: () => widget(), createEl: () => widget() });
  item.doc.body = { createDiv: options => { const palette = widget(); created.push({ options, palette }); return palette; } };
  globalThis.document = { body: { createDiv() { throw Error('Palette was appended to the wrong window'); } } };
  globalThis.createEl = () => widget();
  item.view.prepareDetachedSurface = () => {};
  item.view.trackSelectionPalettePosition = () => {};
  item.view.showSelectionPalette();
  assert.equal(created.length, 1); assert.equal(item.view.selectionPalette, created[0].palette);
  assert.equal(created[0].options.cls, 'lumen-selection-palette');
  item.view.extensionGroupId = 'annotation'; item.view.showExtensionPalette();
  assert.equal(created.length, 2); assert.equal(item.view.selectionPalette, created[1].palette);
  assert.equal(created[1].options.cls, 'lumen-selection-palette lumen-extension-palette');
});
test('visible desktop palette follows resize and scrolling without text rectangle reads or PDF work', () => {
  const item = fixture(); const { view, scroll, palette } = item;
  for (const method of ['mountPage', 'renderMarks', 'releasePageLayers', 'pumpPageMounts']) view[method] = () => { throw Error(`${method} must not run`); };
  view.trackSelectionPalettePosition();
  assert.equal(palette.dataset.placement, 'below');
  scroll.clientHeight = 480; item.owner.dispatchEvent(new Event('resize')); item.frame();
  assert.equal(palette.dataset.placement, 'above'); assert.equal(palette.style.top, '334px');
  scroll.scrollTop = 180; item.doc.dispatchEvent(new Event('scroll')); item.frame();
  assert.equal(palette.dataset.placement, 'below'); assert.equal(palette.style.top, '336px');
  assert.equal(item.counts().rangeReads, 0); assert.equal(item.counts().pageReads, 3);
});
test('extension palettes retain their compact maximum while fully offscreen panes keep controls reachable', () => {
  const item = fixture(); item.palette.classList.add('lumen-extension-palette'); item.view.positionSelectionPalette();
  assert.equal(item.palette.style.maxWidth, '340px');
  const visibleRoot = item.view.rootEl.getBoundingClientRect;
  item.view.rootEl.getBoundingClientRect = () => ({ left: 1300, right: 2200, top: 1000, bottom: 1700 });
  item.view.positionSelectionPalette();
  assert.equal(item.palette.style.maxHeight, '876px');
  assert.equal(item.palette.style.maxWidth, '340px');
  assert.ok(parseFloat(item.palette.style.left) >= 12 && parseFloat(item.palette.style.left) + 340 <= 1188);
  assert.ok(parseFloat(item.palette.style.top) + 50 <= 888);
  item.view.rootEl.getBoundingClientRect = visibleRoot;
  item.view.positionSelectionPalette();
  assert.equal(item.palette.style.maxHeight, '626px');
  assert.equal(item.palette.style.top, '516px');
});
test('event bursts coalesce, stop when idle, and listeners/observers are removed with the palette', () => {
  const item = fixture(); item.view.trackSelectionPalettePosition();
  for (let i = 0; i < 100; i++) { item.doc.dispatchEvent(new Event('scroll')); item.owner.dispatchEvent(new Event('resize')); item.observers[0].callback(); }
  assert.equal(item.frames.size, 1); item.frame(); assert.equal(item.frames.size, 0);
  assert.equal(item.counts().pageReads, 2);
  item.doc.dispatchEvent(new Event('scroll')); assert.equal(item.frames.size, 1);
  item.view.closeSelectionPalette();
  assert.equal(item.frames.size, 0); assert.equal(item.observers[0].disconnected, true); assert.equal(item.counts().removed, true);
  item.doc.dispatchEvent(new Event('scroll')); item.owner.dispatchEvent(new Event('resize')); assert.equal(item.frames.size, 0);
});
test('native selection changes refresh geometry once and ignore collapsed palette interactions', () => {
  const item = fixture(); item.view.trackSelectionPalettePosition(); let captures = 0;
  item.view.captureSelection = () => { captures++; };
  item.setNative({ isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: {}, endContainer: {}, startOffset: 1, endOffset: 8 }) });
  item.doc.dispatchEvent(new Event('selectionchange')); item.frame(); assert.equal(captures, 1);
  item.setNative({ isCollapsed: true, rangeCount: 0 });
  item.doc.dispatchEvent(new Event('selectionchange')); item.frame(); assert.equal(captures, 1);
});
test('mobile keeps its existing palette layout and does not install desktop tracking', () => {
  const item = fixture(MobilePdfView); item.view.trackSelectionPalettePosition(); item.view.scheduleSelectionPalettePosition(); item.view.positionSelectionPalette();
  assert.deepEqual(item.palette.style, {}); assert.equal(item.observers.length, 0); assert.equal(item.frames.size, 0);
});
