import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

async function bundle(entry, mobile = false) {
  const result = await build({
    ...(entry === 'src/view-state.ts' ? { stdin: { contents: 'export * from "./src/view-state"; export { LumenPdfView } from "./src/view";',
      resolveDir: process.cwd(), loader: 'ts' } } : { entryPoints: [entry] }),
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
    plugins: [{ name: 'zoom-test-host', setup(builder) {
      builder.onResolve({ filter: /^obsidian$|^\.\/pdf-runtime$|^pdfjs-dist\/build\/pdf\.mjs$/ }, args => ({ path: args.path, namespace: 'zoom-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'zoom-test' }, args => ({ loader: 'js', contents: args.path === 'obsidian' ? `
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

const { DesktopPdfZoom } = await bundle('src/desktop-zoom.ts');
const { LumenPdfView } = await bundle('src/view.ts');
const { LumenPdfView: MobilePdfView } = await bundle('src/view.ts', true);
const { PdfViewStateManager, LumenPdfView: StatePdfView } = await bundle('src/view-state.ts');

class Scheduler {
  now = 0;
  id = 0;
  frames = new Map();
  timers = new Map();
  requestAnimationFrame = callback => { const id = ++this.id; this.frames.set(id, callback); return id; };
  cancelAnimationFrame = id => { this.frames.delete(id); };
  setTimeout = (callback, delay) => { const id = ++this.id; this.timers.set(id, { callback, at: this.now + delay }); return id; };
  clearTimeout = id => { this.timers.delete(id); };
  getSelection = () => ({ removeAllRanges() {} });
  getComputedStyle = () => ({ visibility: 'visible', paddingLeft: '32px', paddingRight: '32px' });
  frame() {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback(this.now);
  }
  advance(ms) {
    const end = this.now + ms;
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at).find(([, value]) => value.at <= end);
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

class ElementFixture extends EventTarget {
  constructor(ownerDocument, cls = '') {
    super();
    this.ownerDocument = ownerDocument;
    this.className = cls;
    this.children = [];
    this.dataset = {};
    this.isConnected = true;
    this.clientWidth = 900;
    this.clientHeight = 700;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.textContent = '';
    this.value = '';
    this.properties = new Map();
    this.style = {
      setProperty: (name, value) => this.properties.set(name, value),
      removeProperty: name => this.properties.delete(name),
      getPropertyValue: name => this.properties.get(name) ?? '',
    };
    this.classes = new Set(cls.split(' ').filter(Boolean));
    this.classList = {
      add: name => this.classes.add(name), remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
      toggle: (name, enabled) => { if (enabled) this.classes.add(name); else this.classes.delete(name); },
    };
    this.rect = () => ({ left: 100, top: 80, right: 1000, bottom: 780, width: 900, height: 700 });
  }
  createDiv({ cls } = {}) { const child = new ElementFixture(this.ownerDocument, cls); this.append(child); return child; }
  append(child) { this.children.push(child); child.parentElement = this; }
  empty() { this.children.length = 0; }
  remove() { this.isConnected = false; }
  addClass(name) { this.classList.add(name); }
  querySelector(selector) {
    const name = selector.slice(1);
    for (const child of this.children) {
      if (child.classes.has(name)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return this.rect(); }
  scrollTo({ top, left, behavior }) {
    assert.equal(behavior, 'instant');
    if (top !== undefined) this.scrollTop = Math.max(0, Math.min(this.maxTop ?? Infinity, top));
    if (left !== undefined) this.scrollLeft = Math.max(0, Math.min(this.maxLeft ?? Infinity, left));
  }
}

function environment() {
  const scheduler = new Scheduler();
  const doc = { defaultView: scheduler, contains: element => element.isConnected };
  globalThis.window = scheduler;
  globalThis.getComputedStyle = scheduler.getComputedStyle;
  globalThis.HTMLElement = ElementFixture;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  return { scheduler, doc, viewport: new ElementFixture(doc) };
}

function wheel(target, overrides = {}) {
  const event = new Event('wheel', { cancelable: overrides.cancelable ?? true });
  const properties = { ...overrides };
  delete properties.cancelable;
  Object.assign(event, { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    deltaMode: 0, deltaX: 0, deltaY: -2, clientX: 500, clientY: 400, ...properties });
  if (overrides.alreadyCanceled) event.preventDefault();
  target.dispatchEvent(event);
  return event;
}

function controller(initialZoom = 1.25) {
  const { scheduler, viewport } = environment();
  const calls = { begin: 0, previews: [], commits: [], cancel: 0 };
  let ready = true;
  let zoom = initialZoom;
  const control = new DesktopPdfZoom(viewport, {
    isReady: () => ready, currentZoom: () => zoom, begin: () => { calls.begin++; },
    preview: (...args) => calls.previews.push(args),
    commit: (...args) => { calls.commits.push(args); zoom = args[0]; },
    cancel: () => { calls.cancel++; },
  });
  return { scheduler, viewport, calls, control, setReady: value => { ready = value; } };
}

test('ordinary/horizontal wheel, modifiers, canceled and malformed events pass through with no work', () => {
  const { viewport, scheduler, calls } = controller();
  for (const props of [{ ctrlKey: false }, { ctrlKey: false, deltaX: 50, deltaY: 0 },
    { deltaY: 0 }, { shiftKey: true }, { metaKey: true }, { altKey: true },
    { cancelable: false }, { deltaY: NaN }, { deltaY: Infinity }, { clientX: NaN },
    { clientY: Infinity }, { deltaMode: 7 }, { alreadyCanceled: true }]) {
    const event = wheel(viewport, props);
    assert.equal(event.defaultPrevented, Boolean(props.alreadyCanceled));
  }
  assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
  assert.deepEqual(calls, { begin: 0, previews: [], commits: [], cancel: 0 });
});

test('ordinary scrolling never asks the host for layout-dependent readiness', () => {
  const { viewport } = environment();
  let readinessReads = 0;
  const control = new DesktopPdfZoom(viewport, {
    isReady: () => { readinessReads++; return true; }, currentZoom: () => 1.25,
    begin() {}, preview() {}, commit() {}, cancel() {},
  });
  wheel(viewport, { ctrlKey: false });
  wheel(viewport, { ctrlKey: false, deltaX: 100, deltaY: 0 });
  wheel(viewport, { deltaY: 0 });
  assert.equal(readinessReads, 0);
  wheel(viewport);
  assert.equal(readinessReads, 1);
  control.dispose();
});

test('a burst previews once per frame, follows direction changes, and commits once after idle', () => {
  const { viewport, scheduler, calls } = controller();
  for (let index = 0; index < 80; index++) assert.equal(wheel(viewport, { deltaY: -.25 }).defaultPrevented, true);
  assert.equal(calls.begin, 1);
  assert.equal(calls.previews.length, 0);
  assert.equal(scheduler.frames.size, 1);
  assert.equal(scheduler.timers.size, 1);
  scheduler.frame();
  assert.ok(Math.abs(calls.previews[0][0] - 1.25 * Math.exp(.2)) < 1e-12);
  for (let index = 0; index < 40; index++) wheel(viewport, { deltaY: .25, clientX: 550 });
  scheduler.frame();
  assert.ok(calls.previews[1][0] < calls.previews[0][0]);
  assert.equal(calls.previews[1][1], 550);
  scheduler.advance(159);
  assert.equal(calls.commits.length, 0);
  scheduler.advance(1);
  assert.deepEqual(calls.commits, [[1.38, 550, 400]]);
  assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
});

test('bounds consume native zoom without repeated rebuilds and reverse immediately', () => {
  const { viewport, scheduler, calls } = controller(4);
  assert.equal(wheel(viewport, { deltaY: -1000 }).defaultPrevented, true);
  assert.equal(calls.begin, 0);
  assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
  wheel(viewport, { deltaY: 1000 });
  for (let index = 0; index < 30; index++) wheel(viewport, { deltaY: 1000 });
  scheduler.frame();
  assert.equal(calls.previews[0][0], .5);
  wheel(viewport, { deltaY: -2 });
  scheduler.advance(160); // Flush the last pending frame before commit too.
  assert.equal(calls.commits.length, 1);
  assert.equal(calls.commits[0][0], .51);
  assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
});

test('pixel, line and page wheel units are bounded, with cancel/dispose clearing every callback', () => {
  for (const [mode, delta] of [[0, 16], [1, 1]]) {
    const { viewport, scheduler, calls } = controller();
    wheel(viewport, { deltaMode: mode, deltaY: -delta });
    scheduler.advance(160);
    assert.equal(calls.commits[0][0], 1.47);
  }
  const { viewport, scheduler, calls, control } = controller();
  wheel(viewport, { deltaMode: 2, deltaY: -1 });
  control.cancel();
  scheduler.advance(1000);
  scheduler.frame();
  assert.equal(calls.cancel, 1);
  assert.equal(calls.commits.length, 0);
  wheel(viewport);
  control.dispose();
  assert.equal(wheel(viewport).defaultPrevented, false);
  assert.equal(calls.cancel, 2);
  assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
});

test('a document becoming unavailable while RAF or idle is pending cancels rather than committing', () => {
  for (const flushFrame of [false, true]) {
    const { viewport, scheduler, calls, setReady } = controller();
    wheel(viewport);
    if (flushFrame) scheduler.frame();
    setReady(false);
    scheduler.advance(160);
    scheduler.frame();
    assert.equal(calls.cancel, 1);
    assert.equal(calls.commits.length, 0);
    assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
  }
});

test('cancellation from the final preview callback cannot commit afterward', () => {
  const { scheduler, viewport } = environment();
  let commits = 0;
  const control = new DesktopPdfZoom(viewport, {
    isReady: () => true, currentZoom: () => 1.25, begin() {}, cancel() {},
    preview: () => control.dispose(), commit: () => { commits++; },
  });
  wheel(viewport);
  scheduler.advance(160);
  assert.equal(commits, 0);
  assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
});

function renderer({ mobile = false, count = 10, ViewClass } = {}) {
  const { scheduler, doc } = environment();
  const contentEl = new ElementFixture(doc);
  const View = ViewClass ?? (mobile ? MobilePdfView : LumenPdfView);
  const view = new View({ contentEl, containerEl: contentEl, app: { scope: {} } });
  view.getAppAccentColor = () => null;
  view.buildToolbar = function () {
    this.zoomLabel = this.toolbarEl.createDiv({ cls: 'lumen-zoom-label' });
    this.pageInput = this.toolbarEl.createDiv({ cls: 'lumen-page-input' });
    this.pageInput.value = '1';
  };
  view.buildSearchPanel = () => {};
  view.buildOutlinePanel = () => {};
  view.buildInspector = () => {};
  view.updateMobileViewportMetrics = () => {};
  view.file = { path: 'fixture.pdf' };
  view.pdfDocument = { numPages: count, destroy() {} };
  view.buildShell(view.file);
  view.readerReady = true;
  let reads = 0;
  const { rootEl, scrollEl } = view;
  const liveZoom = () => Number(rootEl.style.getPropertyValue('--lumen-zoom'));
  Object.defineProperties(scrollEl, {
    maxTop: { get: () => Math.max(0, 58 + count * 800 * liveZoom() + (count - 1) * 18 + 72 - 700) },
    maxLeft: { get: () => Math.max(0, 600 * liveZoom() + 64 - 900) },
  });
  for (let pageNumber = 1; pageNumber <= count; pageNumber++) {
    const shell = new ElementFixture(doc, 'lumen-page');
    shell.rect = () => {
      reads++;
      const zoom = liveZoom();
      const width = 600 * zoom, height = 800 * zoom;
      const top = 80 + 58 + (pageNumber - 1) * (height + 18) - scrollEl.scrollTop;
      const left = 100 + 32 + Math.max(0, (836 - width) / 2) - scrollEl.scrollLeft;
      return { top, left, width, height, right: left + width, bottom: top + height };
    };
    Object.defineProperty(shell, 'offsetTop', { get: () => 58 + (pageNumber - 1) * (800 * liveZoom() + 18) });
    const state = { pageNumber, shell, stage: null, canvasHost: null, searchHost: null, textHost: null, markHost: null,
      mounted: false, rendering: false, canvasReady: false, canvasDetailReady: false, textReady: false,
      textRendering: false, wanted: false, visibleRatio: 0, renderedPixelRatio: 0,
      renderGeneration: 0, textGeneration: 0, markGeneration: 0 };
    view.pages.set(pageNumber, state);
  }
  return { view, scheduler, scrollEl, rootEl, reads: () => reads };
}

test('actual desktop renderer anchors both axes across centered/overflow layouts without scanning 3000 pages', () => {
  const { view, scheduler, scrollEl, rootEl, reads } = renderer({ count: 3000 });
  scrollEl.scrollTop = 4300;
  const point = { clientX: 700, clientY: 500 };
  const before = view.captureZoomAnchor(point.clientX, point.clientY);
  const initialReads = reads();
  for (let index = 0; index < 15; index++) wheel(scrollEl, { deltaY: -2, ...point });
  scheduler.frame();
  const after = view.captureZoomAnchor(point.clientX, point.clientY);
  assert.equal(before.page, after.page);
  assert.ok(Math.abs(before.xRatio - after.xRatio) < 1e-12);
  assert.ok(Math.abs(before.yRatio - after.yRatio) < 1e-12);
  assert.ok(scrollEl.scrollLeft > 0);
  assert.ok(reads() - initialReads < 32);
  assert.equal(rootEl.classList.contains('is-zooming'), true);
  assert.equal(rootEl.style.getPropertyValue('--lumen-render-zoom'), '1.25');
  assert.equal(Number(rootEl.style.getPropertyValue('--lumen-zoom-preview')), view.currentZoom() / 1.25);
  scheduler.advance(160);
  const committed = view.captureZoomAnchor(point.clientX, point.clientY);
  assert.ok(Math.abs(committed.xRatio - before.xRatio) < 1e-12);
  assert.ok(Math.abs(committed.yRatio - before.yRatio) < 1e-12);
  assert.equal(view.currentZoom(), 1.69);
  assert.equal(rootEl.classList.contains('is-zooming'), false);
  assert.equal(rootEl.style.getPropertyValue('--lumen-render-zoom'), '');
});

test('actual renderer keeps all existing layers in preview, suppresses forced work, and rebuilds once', async () => {
  const { view, scheduler, scrollEl } = renderer();
  const state = view.pages.get(1);
  view.ensurePageLayers(state);
  const layers = [state.stage, state.canvasHost, state.textHost, state.searchHost, state.markHost];
  let canceled = 0, released = 0, fetched = 0;
  state.mounted = true;
  state.canvasReady = true;
  state.textReady = true;
  state.renderTask = { cancel() { canceled++; } };
  state.page = { cleanup() {}, getViewport() { fetched++; } };
  view.mountedPages.add(state);
  const release = view.releasePageLayers.bind(view);
  view.releasePageLayers = value => { released++; release(value); };
  view.pumpPageMounts = () => {};
  view.index.put({ id: 'saved', kind: 'text', page: 1, rects: [{ x: .2, y: .3, width: .2, height: .03 }],
    quote: 'Original saved text', note: 'User note', tags: [], color: '#ffd12d', style: 'highlight', createdAt: 1, updatedAt: 1 });
  const annotations = JSON.stringify(view.index.all());
  state.wanted = true;
  for (let index = 0; index < 100; index++) wheel(scrollEl, { deltaY: -.05 });
  scheduler.frame();
  assert.equal(canceled, 1);
  assert.equal(released, 0);
  assert.deepEqual([state.stage, state.canvasHost, state.textHost, state.searchHost, state.markHost], layers);
  assert.equal(view.pageNeedsCanvasWork(state), false);
  await view.mountPage(state, true);
  await view.renderTextLayer(state);
  assert.equal(fetched, 0);
  assert.equal(view.pendingPageMounts.length, 0);
  scheduler.advance(160);
  assert.equal(released, 1);
  assert.equal(view.pendingPageMounts.length, 1);
  assert.equal(JSON.stringify(view.index.all()), annotations);
  assert.equal(view.currentZoom(), 1.31);
});

test('in-flight forced page acquisition cannot start rendering after a gesture begins', async () => {
  const { view, scheduler, scrollEl } = renderer();
  const state = view.pages.get(1);
  state.wanted = true;
  let resolvePage, renders = 0;
  view.pdfDocument.getPage = () => new Promise(resolve => { resolvePage = resolve; });
  const mounting = view.mountPage(state, true);
  wheel(scrollEl);
  resolvePage({ getViewport() { renders++; throw Error('Unexpected viewport/render work'); } });
  await mounting;
  assert.equal(renders, 0);
  assert.equal(state.rendering, false);
  view.desktopZoom.dispose();
  assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
});

test('a net-zero/sub-percent gesture restores existing layers without releasing them', () => {
  const { view, scheduler, scrollEl } = renderer();
  const state = view.pages.get(1);
  view.ensurePageLayers(state);
  const stage = state.stage;
  state.mounted = true;
  state.canvasReady = true;
  state.canvasDetailReady = true;
  state.textReady = true;
  view.mountedPages.add(state);
  let released = 0;
  view.releasePageLayers = () => { released++; };
  wheel(scrollEl, { deltaY: -.1 });
  scheduler.frame();
  scheduler.advance(160);
  assert.equal(view.currentZoom(), 1.25);
  assert.equal(released, 0);
  assert.equal(state.stage, stage);
  assert.equal(view.rootEl.classList.contains('is-zooming'), false);
  assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
});

test('same-scale restore cancel resumes a text timer and missing canvas work without rebuilding ready layers', async () => {
  const { view, scheduler, scrollEl } = renderer();
  const textState = view.pages.get(1);
  view.ensurePageLayers(textState);
  textState.mounted = true;
  textState.canvasReady = true;
  textState.canvasDetailReady = true;
  textState.wanted = true;
  view.mountedPages.add(textState);
  view.scheduleTextLayer(textState);
  assert.ok(textState.textTimer);
  const canvasState = view.pages.get(2);
  canvasState.wanted = true;
  let renders = 0;
  view.mountPage = async () => { renders++; };
  wheel(scrollEl);
  assert.equal(textState.textTimer, undefined);
  assert.equal(renders, 0);
  await view.restoreZoom(1.25);
  assert.equal(view.desktopZoomPreview, null);
  assert.ok(textState.textTimer);
  assert.equal(renders, 1);
  assert.equal(textState.canvasReady, true);
  await view.teardownDocument(false);
  assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
});

test('pages becoming wanted while a gesture blocks the queue resume after cancel or either commit', async () => {
  for (const settle of ['cancel', 'net-zero', 'changed', 'changed-button']) {
    const { view, scheduler, scrollEl } = renderer();
    const state = view.pages.get(2);
    let mounts = 0;
    view.mountPage = async candidate => { assert.equal(candidate, state); mounts++; };
    wheel(scrollEl, { deltaY: settle === 'changed' ? -5 : -.1 });
    state.wanted = true;
    view.schedulePageMount(state);
    assert.equal(view.pendingPageMounts.length, 0);
    assert.equal(mounts, 0);
    if (settle === 'cancel') await view.restoreZoom(1.25);
    else if (settle === 'changed-button') view.zoomIn();
    else scheduler.advance(160);
    assert.equal(mounts, 1);
    assert.equal(view.desktopZoomPreview, null);
    await view.teardownDocument(false);
    assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
  }
});

test('actual document teardown removes wheel and pending callbacks before closing or switching', async () => {
  for (const preview of [false, true]) {
    const { view, scheduler, scrollEl, rootEl } = renderer();
    let changed = 0;
    rootEl.addEventListener('lumen-zoom-change', () => { changed++; });
    wheel(scrollEl);
    if (preview) scheduler.frame();
    await view.teardownDocument(false); // onLoadFile uses this same path before loading its next PDF.
    view.pdfDocument = { numPages: 1 };
    view.readerReady = true;
    scheduler.advance(1000);
    scheduler.frame();
    assert.equal(view.desktopZoom, null);
    assert.equal(view.currentZoom(), 1.25);
    assert.equal(changed, 0);
    assert.equal(wheel(scrollEl).defaultPrevented, false);
    assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
  }
});

test('mobile does not install a wheel handler and retains its fit/scale rules', async () => {
  const { view, scheduler, scrollEl } = renderer({ mobile: true });
  assert.equal(view.isMobileView(), true);
  assert.equal(view.desktopZoom, null);
  assert.equal(wheel(scrollEl).defaultPrevented, false);
  assert.equal(scheduler.frames.size + scheduler.timers.size, 0);
  assert.equal(view.usesMobileFit(), true);
  await view.restoreZoom(.73, false);
  assert.equal(view.currentZoom(), .75);
  assert.equal(view.usesMobileFit(), false);
  view.resetZoom();
  assert.equal(view.usesMobileFit(), true);
  assert.equal(view.currentZoom(), 1.1);
});

test('precise desktop zoom saves from a gesture without scrolling, restores, and uses the usual button stops', async () => {
  const { view, scheduler, rootEl, scrollEl } = renderer({ ViewClass: StatePdfView });
  const manager = new PdfViewStateManager({ loadData: async () => ({}) }, async () => {});
  manager.attach({ view });
  wheel(scrollEl, { deltaY: -5 });
  scheduler.advance(160);
  scheduler.advance(450);
  assert.equal(manager.data.pdfs['fixture.pdf'].zoom, 1.31);
  view.zoomIn();
  assert.equal(view.currentZoom(), 1.5);
  view.zoomOut();
  assert.equal(view.currentZoom(), 1.25);
  view.restorePage = page => { view.pageInput.value = String(page); };
  await manager.restore(view, rootEl, { zoom: 1.37, page: 4, updatedAt: 1 });
  assert.equal(view.currentZoom(), 1.37);
  assert.equal(view.pageInput.value, '4');
  view.zoomIn();
  assert.equal(view.currentZoom(), 1.5);
  await view.restoreZoom(1.37);
  view.zoomOut();
  assert.equal(view.currentZoom(), 1.25);
  await view.restoreZoom(NaN);
  assert.equal(view.currentZoom(), 1.25);
});

test('detached-root state cleanup keeps the previous PDF scale after the same view switches documents', async () => {
  const { view, rootEl } = renderer({ ViewClass: StatePdfView });
  const manager = new PdfViewStateManager({ loadData: async () => ({}) }, async () => {});
  await view.restoreZoom(1.37);
  await view.teardownDocument(false);
  view.file = { path: 'next.pdf' };
  view.pdfDocument = { numPages: 1 };
  view.buildShell(view.file);
  view.readerReady = true;
  await view.restoreZoom(2);
  manager.capture(view, rootEl, 'fixture.pdf', true);
  assert.equal(manager.data.pdfs['fixture.pdf'].zoom, 1.37);
  assert.equal(view.currentZoom(), 2);
});
