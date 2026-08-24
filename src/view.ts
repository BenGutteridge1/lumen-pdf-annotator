import { FileView, Menu, Notice, Scope, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { annotationMarkdownLink } from "./links";
import { AnnotationIndex, MARK_COLORS, MarkStyle, newAnnotation, newPageNote, NormalizedRect, PdfAnnotation } from "./model";
import { annotationTarget, comparableFileName, QuoteAnnotationRecord, quoteAnnotations } from "./legacy";
import { loadPdf } from "./pdf-runtime";
import { DocumentBundle, LegacyAnnotationRecord, loadLegacyAnnotations, openBundle } from "./storage";

export const LUMEN_VIEW_TYPE = "lumen-pdf-view";
export type PdfTheme = "light" | "sepia" | "dark";
const CARD_HEIGHT = 132;
const CARD_OVERSCAN = 5;
const MAX_INSPECTOR_SCROLL_HEIGHT = 1_000_000;
const MAX_CANVAS_PIXELS = 12_000_000;
const MAX_MARK_CANVAS_PIXELS = 4_000_000;
const MAX_SEARCH_CACHE_CHARS = 24_000_000;
const MAX_SEARCH_CACHE_SPANS = 150_000;
const MAX_SEARCH_RECTS_PER_PAGE = 300;
const MAX_DOM_MARK_RECTS = 96;
const MARK_RECTS_PER_FRAME = 1_200;
const MARK_RECTS_PER_SCROLL_FRAME = 240;
const MARK_HIT_GRID_SIZE = 32;
const PAGE_BUILD_BATCH = 64;
const MAX_CONCURRENT_PAGE_MOUNTS = 1;
const PAGE_UNMOUNT_DELAY_MS = 1_800;
const SCROLL_IDLE_DELAY_MS = 140;
const PAGE_PREVIEW_DELAY_MS = 90;
const TEXT_LAYER_IDLE_DELAY_MS = 80;
const PAGE_DETAIL_DELAY_MS = 480;
const SCROLL_PREVIEW_DPR = .65;

interface PageState {
  pageNumber: number;
  shell: HTMLElement;
  stage: HTMLElement | null;
  canvasHost: HTMLElement | null;
  searchHost: HTMLElement | null;
  textHost: HTMLElement | null;
  markHost: HTMLElement | null;
  page?: any;
  renderTask?: any;
  textTask?: any;
  mounted: boolean;
  rendering: boolean;
  canvasReady: boolean;
  canvasDetailReady: boolean;
  textReady: boolean;
  textRendering: boolean;
  wanted: boolean;
  visibleRatio: number;
  renderedPixelRatio: number;
  unmountTimer?: number;
  textTimer?: number;
  renderGeneration: number;
  textGeneration: number;
  markGeneration: number;
  markFrame?: number;
  markHitGrid?: Map<number, PdfAnnotation[]>;
  markWideHits?: PdfAnnotation[];
}

interface PendingSelection {
  quote: string;
  pages: Map<number, NormalizedRect[]>;
  x: number;
  y: number;
}

interface SearchHit {
  page: number;
  before: string;
  match: string;
  after: string;
  rects: NormalizedRect[];
}

interface SearchPageData {
  text: string;
  spans: QuoteTextSpan[];
}

interface QuoteTextSpan {
  start: number;
  end: number;
  rect: NormalizedRect;
}

interface QuotePageIndex {
  page: number;
  start: number;
  end: number;
  spans: QuoteTextSpan[];
}

interface QuoteDocumentIndex {
  text: string;
  pages: QuotePageIndex[];
}

function iconButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "lumen-icon-button";
  button.setAttribute("aria-label", label);
  setIcon(button, icon);
  button.addEventListener("click", event => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseTags(value: string): string[] {
  return Array.from(new Set(value.split(",").map(tag => tag.trim().replace(/^#/, "")).filter(Boolean)));
}

function markLabel(style: MarkStyle): string {
  if (style === "dashed") return "dashed underline";
  if (style === "dotted") return "dotted underline";
  if (style === "strike") return "strike-through";
  if (style === "comment") return "comment";
  return style;
}

export class LumenPdfView extends FileView {
  private pdfDocument: any = null;
  private pdfWorker: any = null;
  private workerPort: Worker | null = null;
  private bundle: DocumentBundle | null = null;
  private index = new AnnotationIndex();
  private rootEl!: HTMLElement;
  private scrollEl!: HTMLElement;
  private pagesEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private searchPanel!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private searchResults!: HTMLElement;
  private inspector!: HTMLElement;
  private inspectorList!: HTMLElement;
  private inspectorQuery!: HTMLInputElement;
  private annotationCount!: HTMLElement;
  private observer: IntersectionObserver | null = null;
  private readonly pages = new Map<number, PageState>();
  private readonly mountedPages = new Set<PageState>();
  private readonly pendingPageMounts: PageState[] = [];
  private readonly queuedPageMounts = new Set<PageState>();
  private activePageMounts = 0;
  private zoom = 1.25;
  private baselineWidth = 760;
  private baselineHeight = 984;
  private currentPage = 1;
  private theme: PdfTheme;
  private activeFilter: "all" | "highlights" | "notes" = "all";
  private activeColor = "all";
  private inspectorSort: "newest" | "oldest" | "page" = "newest";
  private selection: PendingSelection | null = null;
  private selectionPalette: HTMLElement | null = null;
  private suppressNextSelectionCapture = false;
  private extensionGroupId: string | null = null;
  private editor: HTMLElement | null = null;
  private searchGeneration = 0;
  private inspectorRaf = 0;
  private currentPageRaf = 0;
  private scrollIdleTimer = 0;
  private pagePreviewTimer = 0;
  private pagePreviewReadyAt = 0;
  private pageDetailTimer = 0;
  private pageDetailReadyAt = 0;
  private lastScrollTop = 0;
  private scrollDirection: -1 | 1 = 1;
  private isScrolling = false;
  private pageNotePlacement = false;
  private pageNoteButton: HTMLButtonElement | null = null;
  private readonly pageTextCache = new Map<number, SearchPageData>();
  private pageTextCacheChars = 0;
  private pageTextCacheSpans = 0;
  private readonly searchHitsByPage = new Map<number, SearchHit[]>();
  private activeSearchHit: SearchHit | null = null;
  private inspectorCacheRevision = -1;
  private inspectorCacheKey = "";
  private inspectorCache: PdfAnnotation[] = [];
  private documentGeneration = 0;

  constructor(
    leaf: WorkspaceLeaf,
    initialTheme: PdfTheme = "light",
    private readonly onThemeChange?: (theme: PdfTheme) => void,
    private readonly legacyAnnotationFolder = "PDF annotations",
    private readonly automaticPdfBackups = false,
  ) {
    super(leaf);
    this.theme = initialTheme;
    // A view scope is active only while this PDF pane has focus. Its bindings
    // shadow inherited/global bindings, so Cmd/Ctrl+F cannot invoke another
    // plugin's find command while it opens Lumen's PDF search.
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "f", () => {
      this.toggleSearch();
      return false;
    });
    this.scope.register(["Mod", "Shift"], "a", () => {
      this.toggleInspector();
      return false;
    });
    this.scope.register(["Mod", "Shift"], "=", () => {
      this.zoomIn();
      return false;
    });
    this.scope.register(["Mod"], "-", () => {
      this.zoomOut();
      return false;
    });
    this.scope.register(["Mod"], "0", () => {
      this.resetZoom();
      return false;
    });
  }

  getViewType(): string { return LUMEN_VIEW_TYPE; }
  getDisplayText(): string { return this.file?.basename ?? "Lumen PDF"; }
  getIcon(): string { return "file-text"; }
  canAcceptExtension(extension: string): boolean { return extension.toLowerCase() === "pdf"; }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("lumen-host");
  }

  async onClose(): Promise<void> {
    await this.teardownDocument();
  }

  async onLoadFile(file: TFile): Promise<void> {
    const generation = ++this.documentGeneration;
    await this.teardownDocument(false);
    if (generation !== this.documentGeneration) return;
    const bytes = await this.app.vault.readBinary(file);
    if (generation !== this.documentGeneration) return;
    const bundle = await openBundle(this.app.vault, file, bytes, this.automaticPdfBackups);
    if (generation !== this.documentGeneration) return;
    const indexPromise = bundle.repository.load();
    const loaded = await loadPdf(bytes);
    if (generation !== this.documentGeneration) {
      try { await loaded.document?.destroy?.(); } catch { /* a newer document owns the view */ }
      try { await loaded.worker?.destroy?.(); } catch { /* already gone */ }
      loaded.port.terminate();
      return;
    }
    this.pdfDocument = loaded.document;
    this.pdfWorker = loaded.worker;
    this.workerPort = loaded.port;
    this.buildShell(file);
    await this.buildPages(generation);
    if (generation !== this.documentGeneration) return;
    const index = await indexPromise;
    if (generation !== this.documentGeneration) return;
    this.bundle = bundle;
    this.index = index;
    for (const state of this.mountedPages) this.renderMarks(state.pageNumber);
    this.refreshInspector();
  }

  async onUnloadFile(): Promise<void> {
    await this.teardownDocument();
  }

  toggleSearch(): void {
    const opening = !this.searchPanel.classList.contains("is-open");
    this.searchPanel.classList.toggle("is-open", opening);
    if (opening) window.setTimeout(() => this.searchInput.focus(), 0);
    else {
      this.searchGeneration++;
      this.clearSearchFlashes();
      this.searchInput.value = "";
      this.searchResults.empty();
    }
  }

  toggleInspector(): void {
    const opening = !this.inspector.classList.contains("is-open");
    this.inspector.classList.toggle("is-open", opening);
    this.rootEl.classList.toggle("has-inspector", opening);
    if (opening) this.refreshInspector(true);
    else {
      cancelAnimationFrame(this.inspectorRaf);
      this.inspectorList.empty();
      this.inspectorList.scrollTop = 0;
      this.inspector.querySelector(".lumen-inspector-detail")?.remove();
    }
  }

  previousPage(): void { this.goToPage(this.currentPage - 1); }
  nextPage(): void { this.goToPage(this.currentPage + 1); }
  zoomIn(): void { void this.setZoom(this.zoom + 0.25); }
  zoomOut(): void { void this.setZoom(this.zoom - 0.25); }
  resetZoom(): void { void this.setZoom(1.25); }

  async revealAnnotation(idOrGroupId: string): Promise<boolean> {
    const members = this.index.inGroup(idOrGroupId);
    if (!members.length) return false;
    const target = this.index.get(idOrGroupId) ?? members.slice().sort((a, b) => a.page - b.page || a.createdAt - b.createdAt)[0];
    this.goToPage(target.page);
    const state = this.pages.get(target.page);
    if (state && !state.canvasReady) await this.mountPage(state, true);
    window.setTimeout(() => {
      this.flashAnnotation(this.index.groupId(target));
      const mark = state?.markHost?.querySelector<HTMLElement>(`[data-annotation-id="${target.id}"]`);
      if (mark) this.openEditor(target, mark);
      else if (state) this.openEditorAtRect(target, this.annotationClientRect(target, state));
    }, 360);
    return true;
  }

  togglePageNotePlacement(): void {
    this.pageNotePlacement = !this.pageNotePlacement;
    this.pageNoteButton?.classList.toggle("is-active", this.pageNotePlacement);
    this.pageNoteButton?.setAttribute("aria-pressed", String(this.pageNotePlacement));
    this.rootEl?.classList.toggle("is-placing-page-note", this.pageNotePlacement);
  }

  async checkpointAnnotations(): Promise<void> {
    if (this.bundle) await this.bundle.repository.checkpoint(this.index);
  }

  async exportAnnotations(): Promise<string | null> {
    if (!this.bundle || !this.file) return null;
    const safeName = this.file.basename.replace(/[\\/:*?"<>|]/g, "-");
    const path = `.lumen-pdf/exports/${safeName}.annotations.md`;
    await this.bundle.repository.exportTo(path, this.index);
    return path;
  }

  private buildShell(file: TFile): void {
    this.contentEl.empty();
    this.rootEl = this.contentEl.createDiv({ cls: `lumen-reader theme-${this.theme}` });
    const appAccent = this.getAppAccentColor();
    if (appAccent) this.rootEl.style.setProperty("--lumen-accent", appAccent);
    this.rootEl.style.setProperty("--lumen-zoom", String(this.zoom));
    this.toolbarEl = this.rootEl.createDiv({ cls: "lumen-toolbar" });
    this.scrollEl = this.rootEl.createDiv({ cls: "lumen-scroll" });
    this.pagesEl = this.scrollEl.createDiv({ cls: "lumen-pages" });
    this.searchPanel = this.rootEl.createDiv({ cls: "lumen-search-panel" });
    this.inspector = this.rootEl.createDiv({ cls: "lumen-inspector" });
    this.buildToolbar(file);
    this.buildSearchPanel();
    this.buildInspector();
    this.pagesEl.addEventListener("click", event => {
      const state = this.pageStateFromEvent(event);
      if (!state) return;
      const mark = event.target instanceof Element ? event.target.closest<HTMLElement>(".lumen-mark") : null;
      const annotation = mark?.dataset.annotationId ? this.index.get(mark.dataset.annotationId) : null;
      if (mark && annotation) {
        event.preventDefault();
        event.stopPropagation();
        this.openEditor(annotation, mark);
        return;
      }
      if (this.pageNotePlacement) {
        event.preventDefault();
        event.stopPropagation();
        this.placePageNote(event, state);
        return;
      }
      this.openDenseAnnotationAtPoint(event, state);
    });
    this.pagesEl.addEventListener("contextmenu", event => {
      const state = this.pageStateFromEvent(event);
      if (!state) return;
      const mark = event.target instanceof Element ? event.target.closest<HTMLElement>(".lumen-mark") : null;
      const annotation = mark?.dataset.annotationId ? this.index.get(mark.dataset.annotationId) : null;
      if (annotation) {
        event.preventDefault();
        event.stopPropagation();
        this.showAnnotationMenu(event, annotation);
      } else this.openDenseAnnotationMenuAtPoint(event, state);
    });
    this.pagesEl.addEventListener("pointerdown", event => {
      if (event.target instanceof Element && event.target.closest(".lumen-mark")) event.stopPropagation();
    });
    this.scrollEl.addEventListener("mouseup", event => {
      if (this.suppressNextSelectionCapture) {
        this.suppressNextSelectionCapture = false;
        return;
      }
      this.captureSelection(event);
    });
    this.scrollEl.addEventListener("scroll", () => {
      this.handleScrollActivity();
      cancelAnimationFrame(this.currentPageRaf);
      this.currentPageRaf = requestAnimationFrame(() => {
        this.updateCurrentPage();
        this.pumpPageMounts();
      });
    }, { passive: true });
    this.rootEl.addEventListener("pointerdown", event => {
      const target = event.target as Node;
      if (this.selectionPalette && !this.selectionPalette.contains(target)) {
        this.suppressNextSelectionCapture = true;
        this.closeSelectionPalette();
      }
      if (this.editor && !this.editor.contains(target) && !(target as Element).closest?.(".lumen-mark")) this.closeEditor();
    });
  }

  private buildToolbar(file: TFile): void {
    this.toolbarEl.setAttribute("aria-label", `${file.name} PDF controls`);

    const pageGroup = this.toolbarEl.createDiv({ cls: "lumen-control-group lumen-page-group" });
    pageGroup.append(iconButton("chevron-left", "Previous page", () => this.previousPage()));
    const pageIndicator = pageGroup.createDiv({ cls: "lumen-page-indicator" });
    const pageInput = document.createElement("input");
    pageInput.className = "lumen-page-input";
    pageInput.type = "number";
    pageInput.min = "1";
    pageInput.value = "1";
    pageInput.setAttribute("aria-label", "Page number");
    pageInput.addEventListener("change", () => this.goToPage(Number(pageInput.value)));
    pageInput.addEventListener("focus", () => pageInput.select());
    pageInput.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.goToPage(Number(pageInput.value));
      pageInput.blur();
    });
    pageIndicator.append(pageInput);
    pageIndicator.createSpan({ cls: "lumen-page-separator", text: "/" });
    const pageTotal = pageIndicator.createSpan({ cls: "lumen-page-total", text: "–" });
    pageGroup.append(iconButton("chevron-right", "Next page", () => this.nextPage()));

    const zoomGroup = this.toolbarEl.createDiv({ cls: "lumen-control-group lumen-zoom-group" });
    zoomGroup.append(iconButton("minus", "Zoom out", () => this.zoomOut()));
    const zoomLabel = zoomGroup.createSpan({ cls: "lumen-zoom-label", text: "125%" });
    zoomGroup.append(iconButton("plus", "Zoom in", () => this.zoomIn()));

    const actions = this.toolbarEl.createDiv({ cls: "lumen-toolbar-actions" });
    actions.append(iconButton("search", "Search PDF", () => this.toggleSearch()));
    actions.append(iconButton("messages-square", "Annotations", () => this.toggleInspector()));
    this.pageNoteButton = iconButton("sticky-note", "Place a page note", () => this.togglePageNotePlacement());
    this.pageNoteButton.setAttribute("aria-pressed", "false");
    actions.append(this.pageNoteButton);
    const themes = actions.createDiv({ cls: "lumen-theme-switcher" });
    for (const value of ["light", "sepia", "dark"] as const) {
      const button = themes.createEl("button", { text: value[0].toUpperCase() + value.slice(1) });
      button.classList.toggle("is-active", value === this.theme);
      button.addEventListener("click", () => this.setTheme(value));
    }

    this.toolbarEl.dataset.pageTotalTarget = "true";
    (this.toolbarEl as any)._pageInput = pageInput;
    (this.toolbarEl as any)._pageTotal = pageTotal;
    (this.toolbarEl as any)._zoomLabel = zoomLabel;
  }

  private buildSearchPanel(): void {
    const header = this.searchPanel.createDiv({ cls: "lumen-panel-header" });
    header.createSpan({ text: "Find in PDF" });
    header.append(iconButton("x", "Close PDF search", () => this.toggleSearch()));
    const inputWrap = this.searchPanel.createDiv({ cls: "lumen-search-input-wrap" });
    setIcon(inputWrap.createSpan(), "search");
    this.searchInput = inputWrap.createEl("input", { attr: { type: "search", placeholder: "Search this PDF", "aria-label": "Search this PDF" } });
    this.searchResults = this.searchPanel.createDiv({ cls: "lumen-search-results" });
    let timer = 0;
    this.searchInput.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void this.runSearch(this.searchInput.value), 170);
    });
  }

  private buildInspector(): void {
    const header = this.inspector.createDiv({ cls: "lumen-panel-header" });
    header.createSpan({ text: "Annotations" });
    this.annotationCount = header.createSpan({ cls: "lumen-count", text: "0" });
    header.append(iconButton("x", "Close annotations", () => this.toggleInspector()));
    const inputWrap = this.inspector.createDiv({ cls: "lumen-search-input-wrap" });
    setIcon(inputWrap.createSpan(), "search");
    this.inspectorQuery = inputWrap.createEl("input", { attr: { type: "search", placeholder: "Search annotations", "aria-label": "Search annotations" } });
    let queryTimer = 0;
    this.inspectorQuery.addEventListener("input", () => {
      window.clearTimeout(queryTimer);
      queryTimer = window.setTimeout(() => this.refreshInspector(), 120);
    });
    const filters = this.inspector.createDiv({ cls: "lumen-filter-row" });
    for (const [value, label] of [["all", "All"], ["highlights", "Highlights"], ["notes", "Notes"]] as const) {
      const button = filters.createEl("button", { text: label });
      button.classList.toggle("is-active", value === "all");
      button.addEventListener("click", () => {
        this.activeFilter = value;
        filters.querySelectorAll("button").forEach(item => item.classList.toggle("is-active", item === button));
        this.refreshInspector();
      });
    }
    const options = this.inspector.createDiv({ cls: "lumen-inspector-options" });
    const colorFilters = options.createDiv({ cls: "lumen-inspector-colors", attr: { "aria-label": "Filter annotations by colour" } });
    const allColors = colorFilters.createEl("button", { cls: "lumen-all-colors is-active", text: "All", attr: { "aria-label": "Show all colours" } });
    const colorButtons: HTMLButtonElement[] = [allColors];
    allColors.addEventListener("click", () => {
      this.activeColor = "all";
      colorButtons.forEach(button => button.classList.toggle("is-active", button === allColors));
      this.refreshInspector();
    });
    for (const color of MARK_COLORS) {
      const button = colorFilters.createEl("button", { cls: "lumen-color-chip", attr: { "aria-label": `Show ${color} annotations` } });
      button.style.setProperty("--mark-color", color);
      button.addEventListener("click", () => {
        this.activeColor = color;
        colorButtons.forEach(item => item.classList.toggle("is-active", item === button));
        this.refreshInspector();
      });
      colorButtons.push(button);
    }
    const sort = options.createEl("select", { cls: "lumen-inspector-sort", attr: { "aria-label": "Sort annotations" } });
    sort.createEl("option", { value: "newest", text: "Newest" });
    sort.createEl("option", { value: "oldest", text: "Oldest" });
    sort.createEl("option", { value: "page", text: "Page" });
    sort.value = this.inspectorSort;
    sort.addEventListener("change", () => {
      this.inspectorSort = sort.value as typeof this.inspectorSort;
      this.refreshInspector();
    });
    this.inspectorList = this.inspector.createDiv({ cls: "lumen-inspector-list" });
    this.inspectorList.addEventListener("scroll", () => {
      cancelAnimationFrame(this.inspectorRaf);
      this.inspectorRaf = requestAnimationFrame(() => this.renderInspectorWindow());
    }, { passive: true });
  }

  private async buildPages(generation: number): Promise<void> {
    if (!this.pdfDocument || generation !== this.documentGeneration) return;
    const first = await this.pdfDocument.getPage(1);
    if (generation !== this.documentGeneration) return;
    const firstViewport = first.getViewport({ scale: 1 });
    this.baselineWidth = firstViewport.width;
    this.baselineHeight = firstViewport.height;
    this.pagesEl.style.setProperty("--lumen-page-width", `${this.baselineWidth}px`);
    this.pagesEl.style.setProperty("--lumen-page-height", `${this.baselineHeight}px`);
    const pageCount = this.pdfDocument.numPages;
    (this.toolbarEl as any)._pageTotal.textContent = String(pageCount);
    this.observer = new IntersectionObserver(entries => {
      if (generation !== this.documentGeneration) return;
      for (const entry of entries) {
        const state = this.pages.get(Number((entry.target as HTMLElement).dataset.page));
        if (!state) continue;
        if (entry.isIntersecting) {
          state.wanted = true;
          state.visibleRatio = entry.intersectionRatio;
          if (state.unmountTimer) window.clearTimeout(state.unmountTimer);
          this.schedulePageMount(state);
        } else {
          state.wanted = false;
          state.visibleRatio = 0;
          this.cancelPendingTextLayer(state);
          if (state.rendering) this.cancelPageRender(state);
          if (state.mounted) {
            state.unmountTimer = window.setTimeout(() => this.unmountIfFar(state), PAGE_UNMOUNT_DELAY_MS);
          }
        }
      }
      this.pumpPageMounts();
    }, { root: this.scrollEl, rootMargin: "360px 0px 360px", threshold: [0.01, 0.5] });

    let fragment = document.createDocumentFragment();
    const batch: HTMLElement[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      if (generation !== this.documentGeneration) return;
      const shell = document.createElement("div");
      shell.className = "lumen-page";
      shell.dataset.page = String(pageNumber);
      const state: PageState = {
        pageNumber, shell, stage: null, canvasHost: null, searchHost: null, textHost: null, markHost: null,
        mounted: false, rendering: false, canvasReady: false, canvasDetailReady: false,
        textReady: false, textRendering: false, wanted: false, visibleRatio: 0,
        renderedPixelRatio: 0, renderGeneration: 0, textGeneration: 0, markGeneration: 0,
      };
      this.pages.set(pageNumber, state);
      fragment.append(shell);
      batch.push(shell);
      if (batch.length >= PAGE_BUILD_BATCH || pageNumber === pageCount) {
        this.pagesEl.append(fragment);
        for (const page of batch) this.observer.observe(page);
        fragment = document.createDocumentFragment();
        batch.length = 0;
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        if (generation !== this.documentGeneration) return;
      }
    }
  }

  private sizePage(state: PageState, width: number, height: number): void {
    state.shell.style.setProperty("--lumen-page-width", `${width}px`);
    state.shell.style.setProperty("--lumen-page-height", `${height}px`);
  }

  private pageStateFromEvent(event: Event): PageState | null {
    const target = event.target instanceof Element ? event.target : null;
    const shell = target?.closest<HTMLElement>(".lumen-page");
    return shell ? this.pages.get(Number(shell.dataset.page)) ?? null : null;
  }

  private ensurePageLayers(state: PageState): void {
    if (state.stage) return;
    state.stage = state.shell.createDiv({ cls: "lumen-page-stage" });
    state.canvasHost = state.stage.createDiv({ cls: "lumen-canvas-layer" });
    state.searchHost = state.stage.createDiv({ cls: "lumen-search-layer" });
    state.textHost = state.stage.createDiv({ cls: "lumen-text-layer" });
    state.markHost = state.stage.createDiv({ cls: "lumen-mark-layer" });
  }

  private releasePageLayers(state: PageState): void {
    state.shell.querySelectorAll("canvas").forEach(canvas => {
      canvas.width = 0;
      canvas.height = 0;
    });
    state.shell.empty();
    state.stage = null;
    state.canvasHost = null;
    state.searchHost = null;
    state.textHost = null;
    state.markHost = null;
  }

  private schedulePageMount(state: PageState): void {
    if (state.rendering || this.queuedPageMounts.has(state) || !this.pageNeedsCanvasWork(state)) {
      if (!this.isScrolling && state.canvasReady) this.scheduleTextLayer(state);
      return;
    }
    this.queuedPageMounts.add(state);
    this.pendingPageMounts.push(state);
    this.pumpPageMounts();
  }

  private pageNeedsCanvasWork(state: PageState): boolean {
    if (this.isScrolling || performance.now() < this.pagePreviewReadyAt) return false;
    return !state.canvasReady
      || (!this.isScrolling && performance.now() >= this.pageDetailReadyAt && !state.canvasDetailReady);
  }

  private pumpPageMounts(): void {
    while (this.activePageMounts < MAX_CONCURRENT_PAGE_MOUNTS && this.pendingPageMounts.length) {
      let bestIndex = -1;
      let bestPriority = Number.POSITIVE_INFINITY;
      for (let index = 0; index < this.pendingPageMounts.length; index++) {
        const candidate = this.pendingPageMounts[index];
        if (!candidate.wanted || candidate.rendering || !this.pageNeedsCanvasWork(candidate)) continue;
        const delta = candidate.pageNumber - this.currentPage;
        const behind = (this.scrollDirection > 0 && delta < 0) || (this.scrollDirection < 0 && delta > 0);
        const priority = Math.abs(delta) * 10 + (behind ? 4 : 0) - candidate.visibleRatio * 20;
        if (priority < bestPriority) {
          bestPriority = priority;
          bestIndex = index;
        }
      }
      if (bestIndex < 0) {
        for (const stale of this.pendingPageMounts) this.queuedPageMounts.delete(stale);
        this.pendingPageMounts.length = 0;
        return;
      }
      const [state] = this.pendingPageMounts.splice(bestIndex, 1);
      this.queuedPageMounts.delete(state);
      if (!state.wanted || state.rendering || !this.pdfDocument || !this.pageNeedsCanvasWork(state)) continue;
      this.activePageMounts++;
      void this.mountPage(state).catch(error => {
        if (error?.name !== "RenderingCancelledException") {
          console.warn(`Lumen could not render PDF page ${state.pageNumber}`, error);
        }
      }).finally(() => {
        this.activePageMounts--;
        this.pumpPageMounts();
      });
    }
  }

  private async mountPage(state: PageState, force = false): Promise<void> {
    if (!this.pdfDocument || state.rendering || (!force && !state.wanted)) return;
    if (!force && !this.pageNeedsCanvasWork(state)) {
      if (!this.isScrolling) this.scheduleTextLayer(state);
      return;
    }
    state.rendering = true;
    state.mounted = true;
    this.mountedPages.add(state);
    this.ensurePageLayers(state);
    const canvasHost = state.canvasHost;
    if (!canvasHost) {
      state.rendering = false;
      return;
    }
    const generation = ++state.renderGeneration;
    try {
      const page = state.page ?? await this.pdfDocument.getPage(state.pageNumber);
      if (!state.mounted || generation !== state.renderGeneration || (!force && !state.wanted)) return;
      state.page = page;
      if (!force && !this.pageNeedsCanvasWork(state)) return;
      const cssViewport = page.getViewport({ scale: this.zoom });
      this.sizePage(state, cssViewport.width / this.zoom, cssViewport.height / this.zoom);
      const fullDetail = force || (!this.isScrolling && performance.now() >= this.pageDetailReadyAt);
      const deviceDpr = Math.max(1, window.devicePixelRatio || 1);
      const requestedDpr = fullDetail ? deviceDpr : Math.min(deviceDpr, SCROLL_PREVIEW_DPR);
      const desiredPixels = cssViewport.width * cssViewport.height * requestedDpr * requestedDpr;
      const pixelFactor = desiredPixels > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / desiredPixels) : 1;
      const targetPixelRatio = requestedDpr * pixelFactor;
      if (state.canvasReady && state.renderedPixelRatio >= targetPixelRatio * .98) {
        state.canvasDetailReady ||= fullDetail;
        return;
      }
      const renderViewport = page.getViewport({ scale: this.zoom * targetPixelRatio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(renderViewport.width));
      canvas.height = Math.max(1, Math.floor(renderViewport.height));
      canvas.style.width = `${cssViewport.width}px`;
      canvas.style.height = `${cssViewport.height}px`;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas 2D context is unavailable");
      const hadReadyCanvas = state.canvasReady;
      if (!hadReadyCanvas) canvasHost.replaceChildren(canvas);
      const renderTask = page.render({ canvasContext: context, viewport: renderViewport });
      state.renderTask = renderTask;
      renderTask.onContinue = (resume: () => void) => {
        if (!state.mounted || generation !== state.renderGeneration || (!force && !state.wanted)) {
          renderTask.cancel();
          return;
        }
        requestAnimationFrame(() => {
          if (state.mounted && generation === state.renderGeneration && (force || state.wanted)) resume();
          else renderTask.cancel();
        });
      };
      let rendered = false;
      try {
        await renderTask.promise;
        rendered = true;
      } catch (error) {
        if ((error as Error)?.name !== "RenderingCancelledException") throw error;
      } finally {
        if (state.renderTask === renderTask) state.renderTask = undefined;
      }
      if (!rendered || !state.mounted || generation !== state.renderGeneration || (!force && !state.wanted)) {
        if (!hadReadyCanvas) {
          canvas.width = 0;
          canvas.height = 0;
          canvas.remove();
          state.canvasReady = false;
        }
        return;
      }
      if (hadReadyCanvas) canvasHost.replaceChildren(canvas);
      state.canvasReady = true;
      state.canvasDetailReady = fullDetail;
      state.renderedPixelRatio = targetPixelRatio;
      this.renderSearchMarks(state.pageNumber);
      this.renderMarks(state.pageNumber);
    } finally {
      state.rendering = false;
      if (state.wanted && generation !== state.renderGeneration) this.schedulePageMount(state);
      if (!this.isScrolling && state.canvasReady && (force || state.wanted)) this.scheduleTextLayer(state);
    }
  }

  private scheduleTextLayer(state: PageState): void {
    if (this.isScrolling || !state.wanted || !state.mounted || !state.canvasReady || state.textReady || state.textRendering || state.textTimer) return;
    if (!this.isPageActuallyVisible(state)) return;
    const remainingDetailDelay = Math.max(0, this.pageDetailReadyAt - performance.now());
    state.textTimer = window.setTimeout(() => {
      state.textTimer = undefined;
      void this.renderTextLayer(state);
    }, Math.ceil(remainingDetailDelay) + TEXT_LAYER_IDLE_DELAY_MS);
  }

  private isPageActuallyVisible(state: PageState): boolean {
    const pageRect = state.shell.getBoundingClientRect();
    const rootRect = this.scrollEl.getBoundingClientRect();
    return pageRect.bottom > rootRect.top && pageRect.top < rootRect.bottom;
  }

  private async renderTextLayer(state: PageState): Promise<void> {
    if (this.isScrolling || !state.wanted || !state.mounted || !state.page || !state.textHost || state.textReady || state.textRendering) return;
    const generation = ++state.textGeneration;
    state.textRendering = true;
    const textHost = state.textHost;
    try {
      const page = state.page;
      const cssViewport = page.getViewport({ scale: this.zoom });
      const textContent = await page.getTextContent();
      if (this.isScrolling || !state.wanted || !state.mounted || generation !== state.textGeneration) return;
      textHost.empty();
      const textLayer = new (await import("pdfjs-dist/build/pdf.mjs") as any).TextLayer({
        textContentSource: textContent,
        container: textHost,
        viewport: cssViewport,
      });
      state.textTask = textLayer;
      try {
        await textLayer.render();
        if (!this.isScrolling && state.wanted && state.mounted && generation === state.textGeneration) state.textReady = true;
      } finally {
        if (state.textTask === textLayer) state.textTask = undefined;
      }
    } catch { /* malformed or cancelled text layers should not block the page */ }
    finally {
      state.textRendering = false;
      if (!this.isScrolling && state.wanted && !state.textReady && generation !== state.textGeneration) {
        this.scheduleTextLayer(state);
      }
    }
  }

  private cancelPendingTextLayer(state: PageState): void {
    if (state.textTimer) window.clearTimeout(state.textTimer);
    state.textTimer = undefined;
    if (!state.textRendering) return;
    state.textGeneration++;
    state.textTask?.cancel?.();
    state.textTask = undefined;
    state.textReady = false;
    state.textHost?.empty();
  }

  private cancelPageRender(state: PageState): void {
    if (!state.renderTask) return;
    state.renderGeneration++;
    state.renderTask.cancel?.();
    state.renderTask = undefined;
  }

  private unmountIfFar(state: PageState): void {
    if (state.wanted || !state.mounted) return;
    this.cancelPageRender(state);
    this.cancelPendingTextLayer(state);
    try { state.page?.cleanup?.(); } catch { /* page resources may already be released */ }
    state.page = undefined;
    state.renderGeneration++;
    state.textGeneration++;
    state.markGeneration++;
    if (state.markFrame) cancelAnimationFrame(state.markFrame);
    this.releasePageLayers(state);
    state.markHitGrid = undefined;
    state.markWideHits = undefined;
    state.mounted = false;
    state.canvasReady = false;
    state.canvasDetailReady = false;
    state.textReady = false;
    state.renderedPixelRatio = 0;
    this.mountedPages.delete(state);
  }

  private async setZoom(value: number): Promise<void> {
    this.zoom = clamp(Math.round(value * 4) / 4, 0.5, 4);
    this.rootEl.style.setProperty("--lumen-zoom", String(this.zoom));
    (this.toolbarEl as any)._zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    for (const state of Array.from(this.mountedPages)) {
      this.cancelPageRender(state);
      this.cancelPendingTextLayer(state);
      try { state.page?.cleanup?.(); } catch { /* page resources may already be released */ }
      state.renderGeneration++;
      state.textGeneration++;
      state.markGeneration++;
      if (state.markFrame) cancelAnimationFrame(state.markFrame);
      this.releasePageLayers(state);
      state.mounted = false;
      state.rendering = false;
      state.canvasReady = false;
      state.canvasDetailReady = false;
      state.textReady = false;
      state.renderedPixelRatio = 0;
      this.mountedPages.delete(state);
      if (state.wanted) this.schedulePageMount(state);
    }
    this.pumpPageMounts();
  }

  setTheme(theme: PdfTheme): void {
    const changed = this.theme !== theme;
    this.theme = theme;
    const appAccent = this.getAppAccentColor();
    if (appAccent) this.rootEl.style.setProperty("--lumen-accent", appAccent);
    this.rootEl.classList.remove("theme-light", "theme-sepia", "theme-dark");
    this.rootEl.classList.add(`theme-${theme}`);
    this.toolbarEl.querySelectorAll(".lumen-theme-switcher button").forEach(button => {
      button.classList.toggle("is-active", button.textContent?.toLowerCase() === theme);
    });
    this.syncDetachedTheme(this.selectionPalette);
    this.syncDetachedTheme(this.editor);
    if (changed) this.onThemeChange?.(theme);
  }

  private syncDetachedTheme(surface: HTMLElement | null): void {
    if (!surface) return;
    surface.classList.remove("theme-light", "theme-sepia", "theme-dark");
    surface.classList.add(`theme-${this.theme}`);
    const appAccent = this.getAppAccentColor();
    if (appAccent) surface.style.setProperty("--lumen-accent", appAccent);
  }

  private getAppAccentColor(): string {
    // Reading a custom property returns its unresolved var() expression. Resolve
    // it on a neutral probe before PDF theme classes can replace its HSL inputs.
    const probe = document.body.createSpan({ cls: "lumen-accent-probe" });
    probe.setCssProps({ color: "var(--interactive-accent)" });
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return accent;
  }

  private updateCurrentPage(): void {
    if (!this.pdfDocument) return;
    const target = this.scrollEl.scrollTop + 24;
    let low = 1;
    let high = this.pdfDocument.numPages;
    let bestPage = 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const shell = this.pages.get(middle)?.shell;
      if (!shell) break;
      if (shell.offsetTop <= target) {
        bestPage = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    this.currentPage = bestPage;
    (this.toolbarEl as any)._pageInput.value = String(bestPage);
  }

  private handleScrollActivity(): void {
    window.clearTimeout(this.pagePreviewTimer);
    this.pagePreviewTimer = 0;
    this.pagePreviewReadyAt = Number.POSITIVE_INFINITY;
    window.clearTimeout(this.pageDetailTimer);
    this.pageDetailTimer = 0;
    this.pageDetailReadyAt = Number.POSITIVE_INFINITY;
    const nextScrollTop = this.scrollEl.scrollTop;
    if (nextScrollTop !== this.lastScrollTop) this.scrollDirection = nextScrollTop > this.lastScrollTop ? 1 : -1;
    this.lastScrollTop = nextScrollTop;
    if (!this.isScrolling) {
      this.isScrolling = true;
      for (const state of this.mountedPages) {
        this.cancelPendingTextLayer(state);
        if (state.rendering) this.cancelPageRender(state);
      }
    }
    window.clearTimeout(this.scrollIdleTimer);
    this.scrollIdleTimer = window.setTimeout(() => this.finishScrollActivity(), SCROLL_IDLE_DELAY_MS);
  }

  private finishScrollActivity(): void {
    this.scrollIdleTimer = 0;
    this.isScrolling = false;
    this.pagePreviewReadyAt = performance.now() + PAGE_PREVIEW_DELAY_MS;
    this.pageDetailReadyAt = performance.now() + PAGE_DETAIL_DELAY_MS;
    this.updateCurrentPage();
    this.pagePreviewTimer = window.setTimeout(() => this.finishPagePreviews(), PAGE_PREVIEW_DELAY_MS);
    this.pageDetailTimer = window.setTimeout(() => this.finishPageDetails(), PAGE_DETAIL_DELAY_MS);
  }

  private finishPagePreviews(): void {
    this.pagePreviewTimer = 0;
    if (this.isScrolling) return;
    this.pagePreviewReadyAt = 0;
    const wanted = Array.from(this.pages.values())
      .filter(state => state.wanted)
      .sort((left, right) => Math.abs(left.pageNumber - this.currentPage) - Math.abs(right.pageNumber - this.currentPage));
    for (const state of wanted) this.schedulePageMount(state);
    this.pumpPageMounts();
  }

  private finishPageDetails(): void {
    this.pageDetailTimer = 0;
    if (this.isScrolling) return;
    this.pageDetailReadyAt = 0;
    const wanted = Array.from(this.pages.values())
      .filter(state => state.wanted)
      .sort((left, right) => Math.abs(left.pageNumber - this.currentPage) - Math.abs(right.pageNumber - this.currentPage));
    for (const state of wanted) {
      this.schedulePageMount(state);
      this.scheduleTextLayer(state);
    }
    this.pumpPageMounts();
  }

  private goToPage(page: number): void {
    if (!this.pdfDocument) return;
    const target = clamp(Math.round(page), 1, this.pdfDocument.numPages);
    const shell = this.pages.get(target)?.shell;
    if (!shell) return;
    this.currentPage = target;
    (this.toolbarEl as any)._pageInput.value = String(target);
    const rootRect = this.scrollEl.getBoundingClientRect();
    const targetTop = this.scrollEl.scrollTop + shell.getBoundingClientRect().top - rootRect.top - 14;
    this.scrollEl.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  }

  private captureSelection(event: MouseEvent): void {
    const nativeSelection = window.getSelection();
    if (!nativeSelection || nativeSelection.isCollapsed || !nativeSelection.rangeCount) return;
    const quote = nativeSelection.toString().trim();
    if (!quote) return;
    const rects = Array.from(nativeSelection.getRangeAt(0).getClientRects()).filter(rect => rect.width > 1 && rect.height > 1);
    if (!rects.length) return;
    const byPage = new Map<number, NormalizedRect[]>();
    const [firstPage, lastPage] = this.pageRangeForClientRects(rects);
    for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber++) {
      const state = this.pages.get(pageNumber);
      if (!state?.stage) continue;
      const pageRect = state.stage.getBoundingClientRect();
      const normalized: NormalizedRect[] = [];
      for (const rect of rects) {
        const left = Math.max(rect.left, pageRect.left);
        const right = Math.min(rect.right, pageRect.right);
        const top = Math.max(rect.top, pageRect.top);
        const bottom = Math.min(rect.bottom, pageRect.bottom);
        if (right <= left || bottom <= top) continue;
        normalized.push({
          x: (left - pageRect.left) / pageRect.width,
          y: (top - pageRect.top) / pageRect.height,
          width: (right - left) / pageRect.width,
          height: (bottom - top) / pageRect.height,
        });
      }
      if (normalized.length) byPage.set(state.pageNumber, normalized);
    }
    if (!byPage.size) return;
    this.selection = { quote, pages: byPage, x: event.clientX, y: event.clientY };
    if (this.extensionGroupId) this.showExtensionPalette();
    else this.showSelectionPalette();
  }

  private pageRangeForClientRects(rects: DOMRect[]): [number, number] {
    if (!this.pdfDocument) return [1, 0];
    const root = this.scrollEl.getBoundingClientRect();
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const rect of rects) {
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
    }
    const minY = this.scrollEl.scrollTop + top - root.top;
    const maxY = this.scrollEl.scrollTop + bottom - root.top;
    let low = 1;
    let high = this.pdfDocument.numPages;
    let first = high;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const shell = this.pages.get(middle)?.shell;
      if (!shell) break;
      if (shell.offsetTop + shell.offsetHeight >= minY) {
        first = middle;
        high = middle - 1;
      } else low = middle + 1;
    }
    low = first;
    high = this.pdfDocument.numPages;
    let last = first;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const shell = this.pages.get(middle)?.shell;
      if (!shell) break;
      if (shell.offsetTop <= maxY) {
        last = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return [first, last];
  }

  private showSelectionPalette(): void {
    if (!this.selection) return;
    const pendingSelection = this.selection;
    this.selectionPalette?.remove();
    this.selectionPalette = null;
    const palette = document.body.createDiv({ cls: "lumen-selection-palette" });
    this.syncDetachedTheme(palette);
    this.selectionPalette = palette;
    let pendingColor: string = MARK_COLORS[0];
    const colorChips: HTMLButtonElement[] = [];
    const colors = palette.createDiv({ cls: "lumen-color-row" });
    for (const color of MARK_COLORS) {
      const chip = colors.createEl("button", { cls: "lumen-color-chip", attr: { "aria-label": `Choose ${color}` } });
      chip.dataset.color = color;
      chip.style.setProperty("--mark-color", color);
      chip.classList.toggle("is-active", color === pendingColor);
      chip.setAttribute("aria-pressed", String(color === pendingColor));
      chip.addEventListener("click", event => {
        event.stopPropagation();
        pendingColor = color;
        for (const item of colorChips) {
          const active = item === chip;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-pressed", String(active));
        }
      });
      colorChips.push(chip);
    }
    const styles = palette.createDiv({ cls: "lumen-style-row lumen-selection-styles" });
    for (const [style, icon] of [["highlight", "highlighter"], ["underline", "underline"], ["dashed", "minus"], ["dotted", "ellipsis"], ["strike", "strikethrough"], ["box", "square"], ["comment", "message-square"]] as const) {
      styles.append(iconButton(icon, `Apply ${markLabel(style)}`, () => {
        this.commitSelection(style, pendingColor, style === "comment");
      }));
    }
    const actions = palette.createDiv({ cls: "lumen-palette-actions" });
    actions.append(iconButton("copy", "Copy selected text", () => {
      void navigator.clipboard.writeText(pendingSelection.quote);
      this.closeSelectionPalette();
    }));
    const width = palette.offsetWidth || 390;
    palette.style.left = `${clamp(pendingSelection.x - width / 2, 12, window.innerWidth - width - 12)}px`;
    palette.style.top = `${clamp(pendingSelection.y + 12, 12, window.innerHeight - 96)}px`;
  }

  private showExtensionPalette(): void {
    if (!this.selection || !this.extensionGroupId) return;
    const pendingSelection = this.selection;
    this.selectionPalette?.remove();
    const palette = document.body.createDiv({ cls: "lumen-selection-palette lumen-extension-palette" });
    this.syncDetachedTheme(palette);
    this.selectionPalette = palette;
    palette.createSpan({ cls: "lumen-extension-label", text: "Extend annotation" });
    const actions = palette.createDiv({ cls: "lumen-palette-actions" });
    actions.append(iconButton("check", "Apply extension", () => this.commitExtension()));
    actions.append(iconButton("x", "Cancel extension", () => this.cancelExtension()));
    const width = palette.offsetWidth || 210;
    palette.style.left = `${clamp(pendingSelection.x - width / 2, 12, window.innerWidth - width - 12)}px`;
    palette.style.top = `${clamp(pendingSelection.y + 12, 12, window.innerHeight - 96)}px`;
  }

  private commitExtension(): void {
    if (!this.selection || !this.extensionGroupId || !this.bundle) return;
    const members = this.index.inGroup(this.extensionGroupId);
    if (!members.length) {
      this.cancelExtension();
      new Notice("The annotation to extend could not be found.");
      return;
    }
    const selection = this.selection;
    const groupId = this.extensionGroupId;
    const template = this.index.get(groupId) ?? members[0];
    const now = Date.now();
    const normalizedExtension = selection.quote.replace(/\s+/g, " ").trim();
    const originalQuote = template.quote.replace(/\s+/g, " ").trim();
    const mergedQuote = !normalizedExtension || originalQuote.includes(normalizedExtension)
      ? originalQuote
      : `${originalQuote} ${normalizedExtension}`.trim();
    const byPage = new Map<number, PdfAnnotation>();
    for (const member of members) if (!byPage.has(member.page)) byPage.set(member.page, member);
    const updated = new Map<string, PdfAnnotation>();
    for (const member of members) {
      updated.set(member.id, { ...member, groupId, quote: mergedQuote, updatedAt: now });
    }
    for (const [page, rects] of selection.pages) {
      const existing = byPage.get(page);
      if (existing) {
        updated.set(existing.id, {
          ...existing,
          groupId,
          quote: mergedQuote,
          rects: this.mergeAnnotationRects(existing.rects, rects),
          updatedAt: now,
        });
      } else {
        const continuation = newAnnotation(page, this.mergeAnnotationRects([], rects), mergedQuote, template.color, template.style);
        continuation.groupId = groupId;
        continuation.note = template.note;
        continuation.tags = template.tags.slice();
        updated.set(continuation.id, continuation);
      }
    }
    const pages = new Set<number>();
    for (const annotation of updated.values()) {
      this.index.put(annotation);
      this.bundle.repository.queue({ op: "put", annotation });
      pages.add(annotation.page);
    }
    this.closeSelectionPalette();
    this.finishExtension();
    for (const page of pages) this.renderMarks(page);
    this.refreshInspector();
    new Notice(`Annotation extended across ${pages.size} page${pages.size === 1 ? "" : "s"}.`);
  }

  private mergeAnnotationRects(existing: NormalizedRect[], added: NormalizedRect[]): NormalizedRect[] {
    const merged = existing.slice();
    for (const rect of added) {
      const duplicate = merged.some(item => Math.abs(item.x - rect.x) < .0005
        && Math.abs(item.y - rect.y) < .0005
        && Math.abs(item.width - rect.width) < .0005
        && Math.abs(item.height - rect.height) < .0005);
      if (!duplicate) merged.push(rect);
    }
    return merged;
  }

  private cancelExtension(): void {
    this.closeSelectionPalette();
    this.finishExtension();
  }

  private finishExtension(): void {
    this.extensionGroupId = null;
    this.rootEl?.classList.remove("is-extending-annotation");
  }

  private commitSelection(style: MarkStyle, color: string, openEditor: boolean): void {
    if (!this.selection || !this.bundle) return;
    let first: PdfAnnotation | null = null;
    for (const [page, rects] of this.selection.pages) {
      const annotation = newAnnotation(page, rects, this.selection.quote, color, style);
      this.index.put(annotation);
      this.bundle.repository.queue({ op: "put", annotation });
      this.renderMarks(page);
      first ??= annotation;
    }
    window.getSelection()?.removeAllRanges();
    this.closeSelectionPalette();
    this.refreshInspector();
    if (openEditor && first) {
      const mark = this.pages.get(first.page)?.markHost?.querySelector<HTMLElement>(`[data-annotation-id="${first.id}"]`);
      if (mark) this.openEditor(first, mark);
    }
  }

  private renderMarks(pageNumber: number): void {
    const state = this.pages.get(pageNumber);
    if (!state?.mounted || !state.markHost) return;
    const markHost = state.markHost;
    state.markGeneration++;
    if (state.markFrame) cancelAnimationFrame(state.markFrame);
    state.markFrame = undefined;
    state.markHitGrid = undefined;
    state.markWideHits = undefined;
    markHost.empty();
    const annotations = this.index.onPage(pageNumber);
    const rectCount = annotations.reduce((total, annotation) => total + annotation.rects.length, 0);
    if (rectCount > MAX_DOM_MARK_RECTS) {
      this.renderDenseMarks(state, annotations, state.markGeneration);
      return;
    }
    for (const annotation of annotations) {
      for (const rect of annotation.rects) {
        const mark = markHost.createDiv({ cls: `lumen-mark style-${annotation.style}` });
        if (annotation.kind === "page-note") {
          mark.addClass("is-page-note");
          mark.setAttribute("aria-label", `Page ${annotation.page} note`);
          setIcon(mark, "sticky-note");
        }
        mark.dataset.annotationId = annotation.id;
        mark.style.setProperty("--mark-color", annotation.color);
        mark.style.left = `${rect.x * 100}%`;
        mark.style.top = `${rect.y * 100}%`;
        mark.style.width = `${rect.width * 100}%`;
        mark.style.height = `${rect.height * 100}%`;
      }
    }
  }

  private renderDenseMarks(state: PageState, annotations: PdfAnnotation[], generation: number): void {
    if (!state.stage || !state.markHost) return;
    const width = Math.max(1, state.stage.clientWidth);
    const height = Math.max(1, state.stage.clientHeight);
    const canvas = state.markHost.createEl("canvas", { cls: "lumen-dense-mark-canvas" });
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const desiredPixels = width * height * dpr * dpr;
    const factor = desiredPixels > MAX_MARK_CANVAS_PIXELS ? Math.sqrt(MAX_MARK_CANVAS_PIXELS / desiredPixels) : 1;
    canvas.width = Math.max(1, Math.floor(width * dpr * factor));
    canvas.height = Math.max(1, Math.floor(height * dpr * factor));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(canvas.width / width, canvas.height / height);
    const hitGrid = new Map<number, PdfAnnotation[]>();
    const wideHits: PdfAnnotation[] = [];
    state.markHitGrid = hitGrid;
    state.markWideHits = wideHits;
    let annotationIndex = 0;
    let rectIndex = 0;

    const drawChunk = () => {
      if (!state.mounted || generation !== state.markGeneration) return;
      let drawn = 0;
      const frameBudget = this.isScrolling ? MARK_RECTS_PER_SCROLL_FRAME : MARK_RECTS_PER_FRAME;
      while (annotationIndex < annotations.length && drawn < frameBudget) {
        const annotation = annotations[annotationIndex];
        while (rectIndex < annotation.rects.length && drawn < frameBudget) {
          const rect = annotation.rects[rectIndex++];
          this.drawDenseMark(context, annotation, rect, width, height);
          this.addDenseHit(hitGrid, wideHits, annotation, rect);
          drawn++;
        }
        if (rectIndex >= annotation.rects.length) {
          annotationIndex++;
          rectIndex = 0;
        }
      }
      if (annotationIndex < annotations.length) state.markFrame = requestAnimationFrame(drawChunk);
      else state.markFrame = undefined;
    };
    drawChunk();
  }

  private drawDenseMark(
    context: CanvasRenderingContext2D,
    annotation: PdfAnnotation,
    rect: NormalizedRect,
    pageWidth: number,
    pageHeight: number,
  ): void {
    const x = rect.x * pageWidth;
    const y = rect.y * pageHeight;
    const width = rect.width * pageWidth;
    const height = rect.height * pageHeight;
    context.save();
    context.fillStyle = annotation.color;
    context.strokeStyle = annotation.color;
    context.lineWidth = annotation.style === "underline" || annotation.style === "dashed" || annotation.style === "dotted" ? 3 : 2;
    if (annotation.kind === "page-note") {
      const size = 26;
      context.globalAlpha = 1;
      context.beginPath();
      context.roundRect(x, y, size, size, 7);
      context.fill();
      context.strokeStyle = "rgba(20,20,20,.62)";
      context.stroke();
      context.beginPath();
      context.moveTo(x + 7, y + 8);
      context.lineTo(x + 19, y + 8);
      context.moveTo(x + 7, y + 13);
      context.lineTo(x + 16, y + 13);
      context.stroke();
    } else if (annotation.style === "highlight") {
      context.globalAlpha = .62;
      context.fillRect(x, y, width, height);
    } else if (annotation.style === "box") {
      context.globalAlpha = .12;
      context.fillRect(x, y, width, height);
      context.globalAlpha = 1;
      context.strokeRect(x + 1, y + 1, Math.max(0, width - 2), Math.max(0, height - 2));
    } else if (annotation.style === "strike") {
      context.beginPath();
      context.moveTo(x, y + height / 2);
      context.lineTo(x + width, y + height / 2);
      context.stroke();
    } else {
      if (annotation.style === "comment") {
        context.globalAlpha = .15;
        context.fillRect(x, y, width, height);
        context.globalAlpha = 1;
      }
      if (annotation.style === "dashed") context.setLineDash([6, 4]);
      if (annotation.style === "dotted" || annotation.style === "comment") {
        context.setLineDash([1, 4]);
        context.lineCap = "round";
      }
      context.beginPath();
      context.moveTo(x, y + height - 1.5);
      context.lineTo(x + width, y + height - 1.5);
      context.stroke();
    }
    context.restore();
  }

  private addDenseHit(
    grid: Map<number, PdfAnnotation[]>,
    wideHits: PdfAnnotation[],
    annotation: PdfAnnotation,
    rect: NormalizedRect,
  ): void {
    const padding = annotation.kind === "page-note" ? 1 : 0;
    const left = clamp(Math.floor(rect.x * MARK_HIT_GRID_SIZE) - padding, 0, MARK_HIT_GRID_SIZE - 1);
    const right = clamp(Math.floor((rect.x + rect.width) * MARK_HIT_GRID_SIZE) + padding, 0, MARK_HIT_GRID_SIZE - 1);
    const top = clamp(Math.floor(rect.y * MARK_HIT_GRID_SIZE) - padding, 0, MARK_HIT_GRID_SIZE - 1);
    const bottom = clamp(Math.floor((rect.y + rect.height) * MARK_HIT_GRID_SIZE) + padding, 0, MARK_HIT_GRID_SIZE - 1);
    if ((right - left + 1) * (bottom - top + 1) > 64) {
      if (wideHits.at(-1)?.id !== annotation.id) wideHits.push(annotation);
      return;
    }
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        const key = row * MARK_HIT_GRID_SIZE + column;
        let values = grid.get(key);
        if (!values) grid.set(key, values = []);
        if (values.at(-1)?.id !== annotation.id) values.push(annotation);
      }
    }
  }

  private openDenseAnnotationAtPoint(event: MouseEvent, state: PageState): void {
    const annotation = this.denseAnnotationAtPoint(event, state);
    if (!annotation) return;
    event.preventDefault();
    event.stopPropagation();
    this.openEditorAtRect(annotation, new DOMRect(event.clientX, event.clientY, 1, 1));
  }

  private openDenseAnnotationMenuAtPoint(event: MouseEvent, state: PageState): void {
    const annotation = this.denseAnnotationAtPoint(event, state);
    if (!annotation) return;
    event.preventDefault();
    event.stopPropagation();
    this.showAnnotationMenu(event, annotation);
  }

  private denseAnnotationAtPoint(event: MouseEvent, state: PageState): PdfAnnotation | null {
    const grid = state.markHitGrid;
    if (!grid || !state.mounted || !state.stage) return null;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return null;
    const bounds = state.stage.getBoundingClientRect();
    const x = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
    const y = clamp((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 1);
    const column = clamp(Math.floor(x * MARK_HIT_GRID_SIZE), 0, MARK_HIT_GRID_SIZE - 1);
    const row = clamp(Math.floor(y * MARK_HIT_GRID_SIZE), 0, MARK_HIT_GRID_SIZE - 1);
    const candidates = [state.markWideHits ?? [], grid.get(row * MARK_HIT_GRID_SIZE + column) ?? []];
    const seen = new Set<string>();
    for (const group of candidates) {
      for (let index = group.length - 1; index >= 0; index--) {
        const annotation = group[index];
        if (seen.has(annotation.id)) continue;
        seen.add(annotation.id);
        const hit = annotation.rects.some(rect => {
          const extraX = annotation.kind === "page-note" ? 13 / Math.max(1, bounds.width) : 0;
          const extraY = annotation.kind === "page-note" ? 13 / Math.max(1, bounds.height) : 0;
          return x >= rect.x - extraX && x <= rect.x + rect.width + extraX
            && y >= rect.y - extraY && y <= rect.y + rect.height + extraY;
        });
        if (hit) return annotation;
      }
    }
    return null;
  }

  private showAnnotationMenu(event: MouseEvent, annotation: PdfAnnotation): void {
    const menu = new Menu();
    menu.addItem(item => item
      .setTitle(annotation.kind === "page-note" ? "Copy link to annotation" : "Copy link to highlight")
      .setIcon("link")
      .onClick(() => void this.copyAnnotationLink(annotation)));
    menu.showAtMouseEvent(event);
  }

  private async copyAnnotationLink(annotation: PdfAnnotation): Promise<void> {
    if (!this.file) return;
    const link = annotationMarkdownLink(this.app.vault.getName(), this.file.path, annotation);
    try {
      await navigator.clipboard.writeText(link);
      new Notice(annotation.kind === "page-note" ? "Annotation link copied." : "Highlight link copied.");
    } catch (error) {
      console.error("Lumen could not copy an annotation link", error);
      new Notice("Lumen could not copy the annotation link.");
    }
  }

  private annotationClientRect(annotation: PdfAnnotation, state: PageState): DOMRect {
    const stage = (state.stage ?? state.shell).getBoundingClientRect();
    const rect = annotation.rects[0] ?? { x: 0, y: 0, width: 0, height: 0 };
    return new DOMRect(
      stage.left + rect.x * stage.width,
      stage.top + rect.y * stage.height,
      Math.max(1, rect.width * stage.width),
      Math.max(1, rect.height * stage.height),
    );
  }

  private openEditor(annotation: PdfAnnotation, anchor: HTMLElement): void {
    this.openEditorAtRect(annotation, anchor.getBoundingClientRect());
  }

  private openEditorAtRect(annotation: PdfAnnotation, rect: DOMRect): void {
    if (this.extensionGroupId) this.finishExtension();
    this.closeSelectionPalette();
    this.closeEditor();
    const editor = document.body.createDiv({ cls: `lumen-mark-editor theme-${this.theme}` });
    this.syncDetachedTheme(editor);
    this.editor = editor;
    const heading = editor.createDiv({ cls: "lumen-editor-heading" });
    heading.createSpan({ text: this.annotationPageLabel(annotation, "Page ") });
    heading.append(iconButton("x", "Close editor", () => this.closeEditor()));
    this.populateEditor(editor, annotation, true);
    const width = 330;
    editor.style.left = `${clamp(rect.left, 12, window.innerWidth - width - 12)}px`;
    editor.style.top = `${clamp(rect.bottom + 10, 12, window.innerHeight - 410)}px`;
  }

  private populateEditor(container: HTMLElement, annotation: PdfAnnotation, compact: boolean): void {
    const colors = container.createDiv({ cls: "lumen-color-row" });
    for (const color of MARK_COLORS) {
      const chip = colors.createEl("button", { cls: "lumen-color-chip", attr: { "aria-label": `Use ${color}` } });
      chip.style.setProperty("--mark-color", color);
      chip.classList.toggle("is-active", annotation.color === color);
      chip.addEventListener("click", () => {
        this.mutateAnnotation(annotation.id, { color });
        colors.querySelectorAll(".lumen-color-chip").forEach(item => item.classList.toggle("is-active", item === chip));
      });
    }
    if (annotation.kind !== "page-note") {
      const styles = container.createDiv({ cls: "lumen-style-row" });
      for (const [style, icon] of [["highlight", "highlighter"], ["underline", "underline"], ["dashed", "minus"], ["dotted", "ellipsis"], ["strike", "strikethrough"], ["box", "square"], ["comment", "message-square"]] as const) {
        const button = iconButton(icon, markLabel(style), () => {
          this.mutateAnnotation(annotation.id, { style });
          styles.querySelectorAll(".lumen-icon-button").forEach(item => item.classList.toggle("is-active", item === button));
        });
        button.classList.toggle("is-active", annotation.style === style);
        styles.append(button);
      }
    }
    if (annotation.kind !== "page-note") {
      const quote = container.createDiv({ cls: "lumen-editor-quote", text: annotation.quote });
      if (compact) quote.classList.add("is-compact");
    }
    const note = container.createEl("textarea", { cls: "lumen-note-input", attr: { placeholder: annotation.kind === "page-note" ? "Page note…" : "Add a note…", "aria-label": annotation.kind === "page-note" ? "Page note" : "Annotation note" } });
    note.value = annotation.note;
    const tags = container.createEl("input", { cls: "lumen-tags-input", attr: { placeholder: "Tags, separated by commas", "aria-label": "Annotation tags" } });
    tags.value = annotation.tags.join(", ");
    const save = () => {
      this.mutateAnnotation(annotation.id, { note: note.value, tags: parseTags(tags.value) }, false, false);
    };
    note.addEventListener("input", save);
    tags.addEventListener("input", save);
    const actions = container.createDiv({ cls: "lumen-editor-actions" });
    actions.append(iconButton("copy", "Copy quoted text", () => void navigator.clipboard.writeText(annotation.quote)));
    if (annotation.kind !== "page-note") {
      actions.append(iconButton("scan-text", "Extend annotation", () => this.beginExtension(annotation)));
    }
    if (compact) actions.append(iconButton("panel-right-open", "Open in inspector", () => {
      if (!this.inspector.classList.contains("is-open")) this.toggleInspector();
      this.openInspectorDetail(annotation.id);
      this.closeEditor();
    }));
    const remove = iconButton("trash-2", "Delete annotation", () => this.deleteAnnotation(annotation.id));
    remove.addClass("is-danger");
    actions.append(remove);
  }

  private beginExtension(annotation: PdfAnnotation): void {
    if (annotation.kind === "page-note") return;
    this.extensionGroupId = this.index.groupId(annotation);
    this.rootEl.addClass("is-extending-annotation");
    this.closeEditor();
    new Notice("Select more PDF text, on this page or another page, then confirm the extension.");
  }

  private mutateAnnotation(id: string, patch: Partial<PdfAnnotation>, rerenderInspector = true, rerenderMarks = true): void {
    const members = this.index.inGroup(id);
    if (!members.length || !this.bundle) return;
    const now = Date.now();
    const pages = new Set<number>();
    for (const current of members) {
      const updated = { ...current, ...patch, updatedAt: now };
      this.index.put(updated);
      this.bundle.repository.queue({ op: "put", annotation: updated });
      pages.add(updated.page);
    }
    if (rerenderMarks) for (const page of pages) this.renderMarks(page);
    if (rerenderInspector) this.refreshInspector();
  }

  private deleteAnnotation(id: string): void {
    const members = this.index.inGroup(id);
    if (!members.length || !this.bundle) return;
    const now = Date.now();
    const pages = new Set<number>();
    for (const current of members) {
      this.index.remove(current.id);
      this.bundle.repository.queue({ op: "remove", id: current.id, at: now });
      pages.add(current.page);
    }
    for (const page of pages) this.renderMarks(page);
    this.closeEditor();
    this.inspector.querySelector(".lumen-inspector-detail")?.remove();
    this.refreshInspector();
  }

  private filteredAnnotations(): PdfAnnotation[] {
    const query = this.inspectorQuery?.value.trim().toLowerCase() ?? "";
    const key = `${this.activeFilter}\u0000${this.activeColor}\u0000${this.inspectorSort}\u0000${query}`;
    if (this.inspectorCacheRevision === this.index.version && this.inspectorCacheKey === key) return this.inspectorCache;
    const all = this.index.logicalAll();
    this.inspectorCache = this.activeFilter === "all" && this.activeColor === "all" && !query
      ? all.slice()
      : all.filter(item => {
        if (this.activeFilter === "highlights" && item.kind === "page-note") return false;
        if (this.activeFilter === "notes" && !item.note) return false;
        if (this.activeColor !== "all" && item.color !== this.activeColor) return false;
        if (!query) return true;
        return this.index.matches(item, query);
      });
    if (this.inspectorSort === "newest") this.inspectorCache.reverse();
    else if (this.inspectorSort === "page") this.inspectorCache.sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
    this.inspectorCacheRevision = this.index.version;
    this.inspectorCacheKey = key;
    return this.inspectorCache;
  }

  private usesDirectInspectorWindow(): boolean {
    const query = this.inspectorQuery?.value.trim() ?? "";
    return this.activeFilter === "all"
      && this.activeColor === "all"
      && this.inspectorSort !== "page"
      && !query;
  }

  private inspectorItemCount(): number {
    return this.usesDirectInspectorWindow() ? this.index.logicalSize : this.filteredAnnotations().length;
  }

  private refreshInspector(skipLayoutRead = false): void {
    if (!this.inspectorList) return;
    this.annotationCount.textContent = String(this.index.logicalSize);
    if (!this.inspector.classList.contains("is-open")) {
      this.inspectorList.empty();
      this.inspector.querySelector(".lumen-inspector-detail")?.remove();
      return;
    }
    if (!skipLayoutRead) {
      const virtualHeight = this.inspectorVirtualHeight(this.inspectorItemCount());
      this.inspectorList.scrollTop = Math.min(this.inspectorList.scrollTop, Math.max(0, virtualHeight - this.inspectorList.clientHeight));
    }
    this.renderInspectorWindow(skipLayoutRead ? 500 : undefined, skipLayoutRead ? 0 : undefined);
  }

  private inspectorVirtualHeight(itemCount: number): number {
    return Math.min(itemCount * CARD_HEIGHT, MAX_INSPECTOR_SCROLL_HEIGHT);
  }

  private renderInspectorWindow(viewportOverride?: number, scrollTopOverride?: number): void {
    const directWindow = this.usesDirectInspectorWindow();
    const filteredItems = directWindow ? null : this.filteredAnnotations();
    const itemCount = directWindow ? this.index.logicalSize : filteredItems?.length ?? 0;
    // Read current layout before replacing the window. Initial opening passes
    // explicit values, so it performs no synchronous layout reads at all.
    const scrollTop = scrollTopOverride ?? this.inspectorList.scrollTop;
    this.inspectorList.empty();
    if (!itemCount) {
      this.inspectorList.createDiv({ cls: "lumen-empty", text: "No matching annotations" });
      return;
    }
    const viewport = (viewportOverride ?? this.inspectorList.clientHeight) || 500;
    const logicalHeight = itemCount * CARD_HEIGHT;
    const virtualHeight = this.inspectorVirtualHeight(itemCount);
    const visibleCount = Math.max(1, Math.ceil(viewport / CARD_HEIGHT));
    const maxAnchor = Math.max(0, itemCount - visibleCount);
    const scrollRange = Math.max(1, virtualHeight - viewport);
    const anchor = logicalHeight <= virtualHeight
      ? Math.floor(scrollTop / CARD_HEIGHT)
      : Math.round((scrollTop / scrollRange) * maxAnchor);
    const start = Math.max(0, anchor - CARD_OVERSCAN);
    const end = Math.min(itemCount, anchor + visibleCount + CARD_OVERSCAN);
    const windowItems = directWindow
      ? this.index.logicalSlice(start, end, this.inspectorSort === "newest")
      : filteredItems?.slice(start, end) ?? [];
    const spacer = this.inspectorList.createDiv({ cls: "lumen-virtual-spacer" });
    spacer.style.height = `${virtualHeight}px`;
    const window = spacer.createDiv({ cls: "lumen-virtual-window" });
    const windowHeight = (end - start) * CARD_HEIGHT;
    const windowTop = logicalHeight <= virtualHeight
      ? start * CARD_HEIGHT
      : clamp(scrollTop - CARD_OVERSCAN * CARD_HEIGHT, 0, Math.max(0, virtualHeight - windowHeight));
    window.style.transform = `translateY(${windowTop}px)`;
    for (let offset = 0; offset < windowItems.length; offset++) {
      const item = windowItems[offset];
      const card = window.createDiv({ cls: "lumen-annotation-card" });
      card.style.top = `${offset * CARD_HEIGHT + 4}px`;
      card.style.setProperty("--mark-color", item.color);
      const meta = card.createDiv({ cls: "lumen-card-meta" });
      meta.createEl("strong", { text: this.annotationPageLabel(item, "p.") });
      meta.createSpan({ text: item.kind === "page-note" ? "page note" : item.note ? "note" : markLabel(item.style) });
      card.createDiv({ cls: "lumen-card-note", text: item.note || item.quote });
      if (item.note) card.createDiv({ cls: "lumen-card-quote", text: item.quote });
      card.addEventListener("click", () => {
        this.goToPage(item.page);
        this.flashAnnotation(item.id);
        this.openInspectorDetail(item.id);
      });
    }
  }

  private openInspectorDetail(id: string): void {
    const annotation = this.index.get(id) ?? this.index.inGroup(id)[0];
    if (!annotation) return;
    this.inspector.querySelector(".lumen-inspector-detail")?.remove();
    const detail = this.inspector.createDiv({ cls: "lumen-inspector-detail" });
    const header = detail.createDiv({ cls: "lumen-panel-header" });
    header.append(iconButton("arrow-left", "Back to annotations", () => {
      detail.remove();
      this.refreshInspector();
    }));
    header.createSpan({ text: this.annotationPageLabel(annotation, "Page ") });
    this.populateEditor(detail, annotation, false);
  }

  private flashAnnotation(id: string): void {
    window.setTimeout(() => {
      const members = this.index.inGroup(id);
      for (const annotation of members) {
        const marks = this.rootEl.querySelectorAll<HTMLElement>(`[data-annotation-id="${annotation.id}"]`);
        marks.forEach(mark => mark.classList.add("is-flashing"));
        window.setTimeout(() => marks.forEach(mark => mark.classList.remove("is-flashing")), 900);
      }
    }, 420);
  }

  private annotationPageLabel(annotation: PdfAnnotation, prefix: string): string {
    const pages = Array.from(new Set(this.index.inGroup(annotation.id).map(item => item.page))).sort((a, b) => a - b);
    if (!pages.length) return `${prefix}${annotation.page}`;
    if (pages.length === 1) return `${prefix}${pages[0]}`;
    const consecutive = pages.every((page, index) => index === 0 || page === pages[index - 1] + 1);
    return consecutive ? `${prefix}${pages[0]}–${pages.at(-1)}` : `${prefix}${pages.join(", ")}`;
  }

  private async runSearch(rawQuery: string): Promise<void> {
    const query = rawQuery.trim();
    const generation = ++this.searchGeneration;
    this.searchResults.empty();
    this.clearSearchFlashes();
    if (query.length < 2 || !this.pdfDocument) return;
    this.searchResults.createDiv({ cls: "lumen-search-status", text: "Searching…" });
    const lower = query.toLocaleLowerCase();
    const hits: SearchHit[] = [];
    for (let pageNumber = 1; pageNumber <= this.pdfDocument.numPages; pageNumber++) {
      if (generation !== this.searchGeneration) return;
      if (hits.length >= 2000) break;
      try {
        const pageData = await this.getSearchablePageText(pageNumber);
        const haystack = pageData.text.toLocaleLowerCase();
        let from = 0;
        while (hits.length < 2000) {
          const index = haystack.indexOf(lower, from);
          if (index < 0) break;
          const end = index + query.length;
          hits.push({
            page: pageNumber,
            before: pageData.text.slice(Math.max(0, index - 110), index),
            match: pageData.text.slice(index, end),
            after: pageData.text.slice(end, end + 150),
            rects: this.searchRectsForRange(pageData.spans, index, end),
          });
          from = index + Math.max(1, query.length);
        }
      } catch { /* continue past malformed page text */ }
      if (pageNumber % 6 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    if (generation !== this.searchGeneration) return;
    this.renderSearchHits(hits);
  }

  private async getSearchablePageText(pageNumber: number): Promise<SearchPageData> {
    const cached = this.pageTextCache.get(pageNumber);
    if (cached !== undefined) {
      // Refresh insertion order so repeated searches retain recently used
      // pages rather than the first pages encountered in the document.
      this.pageTextCache.delete(pageNumber);
      this.pageTextCache.set(pageNumber, cached);
      return cached;
    }
    const page = await this.pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    let text = "";
    const spans: QuoteTextSpan[] = [];
    for (const raw of content.items) {
      const item = raw as { str?: string; transform?: number[]; width?: number; height?: number };
      const value = (item.str ?? "").replace(/\s+/g, " ").trim();
      if (!value) continue;
      if (text) text += " ";
      const start = text.length;
      text += value;
      const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
      const x = Number(transform[4]) || 0;
      const y = Number(transform[5]) || 0;
      const width = Math.max(Number(item.width) || 0, 1);
      const height = Math.max(Number(item.height) || Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0), 1);
      const converted = viewport.convertToViewportRectangle([x, y, x + width, y + height]);
      const left = Math.min(converted[0], converted[2]);
      const right = Math.max(converted[0], converted[2]);
      const top = Math.min(converted[1], converted[3]);
      const bottom = Math.max(converted[1], converted[3]);
      spans.push({
        start,
        end: text.length,
        rect: {
          x: clamp(left / viewport.width, 0, 1),
          y: clamp(top / viewport.height, 0, 1),
          width: clamp((right - left) / viewport.width, 0, 1),
          height: clamp((bottom - top) / viewport.height, 0, 1),
        },
      });
    }
    const data = { text, spans };
    this.cacheSearchPage(pageNumber, data);
    if (!this.pages.get(pageNumber)?.mounted) page.cleanup?.();
    return data;
  }

  private cacheSearchPage(pageNumber: number, data: SearchPageData): void {
    if (data.text.length > MAX_SEARCH_CACHE_CHARS || data.spans.length > MAX_SEARCH_CACHE_SPANS) return;
    while (this.pageTextCache.size
      && (this.pageTextCacheChars + data.text.length > MAX_SEARCH_CACHE_CHARS
        || this.pageTextCacheSpans + data.spans.length > MAX_SEARCH_CACHE_SPANS)) {
      const oldestPage = this.pageTextCache.keys().next().value as number | undefined;
      if (oldestPage === undefined) break;
      const oldest = this.pageTextCache.get(oldestPage);
      this.pageTextCache.delete(oldestPage);
      if (oldest) {
        this.pageTextCacheChars -= oldest.text.length;
        this.pageTextCacheSpans -= oldest.spans.length;
      }
    }
    this.pageTextCache.set(pageNumber, data);
    this.pageTextCacheChars += data.text.length;
    this.pageTextCacheSpans += data.spans.length;
  }

  private searchRectsForRange(spans: QuoteTextSpan[], start: number, end: number): NormalizedRect[] {
    return spans.filter(span => span.end > start && span.start < end).map(span => {
      const overlapStart = Math.max(span.start, start);
      const overlapEnd = Math.min(span.end, end);
      const length = Math.max(1, span.end - span.start);
      const startRatio = (overlapStart - span.start) / length;
      return {
        ...span.rect,
        x: span.rect.x + span.rect.width * startRatio,
        width: span.rect.width * ((overlapEnd - overlapStart) / length),
      };
    }).filter(rect => rect.width > 0 && rect.height > 0);
  }

  private renderSearchHits(hits: SearchHit[]): void {
    this.searchResults.empty();
    this.searchHitsByPage.clear();
    this.activeSearchHit = null;
    if (!hits.length) {
      this.searchResults.createDiv({ cls: "lumen-empty", text: "No matches" });
      return;
    }
    for (const hit of hits) {
      let pageHits = this.searchHitsByPage.get(hit.page);
      if (!pageHits) this.searchHitsByPage.set(hit.page, pageHits = []);
      pageHits.push(hit);
    }
    for (const state of this.mountedPages) this.renderSearchMarks(state.pageNumber);
    this.searchResults.createDiv({ cls: "lumen-search-status", text: `${hits.length} match${hits.length === 1 ? "" : "es"}` });
    for (const hit of hits.slice(0, 160)) {
      const card = this.searchResults.createDiv({ cls: "lumen-search-card" });
      card.createDiv({ cls: "lumen-card-meta", text: `p.${hit.page}` });
      const excerpt = card.createDiv({ cls: "lumen-search-excerpt" });
      excerpt.append(document.createTextNode(hit.before));
      excerpt.createEl("mark", { text: hit.match });
      excerpt.append(document.createTextNode(hit.after));
      card.addEventListener("click", () => {
        this.activeSearchHit = hit;
        this.goToPage(hit.page);
        const state = this.pages.get(hit.page);
        if (state) {
          if (state.canvasReady) this.renderSearchMarks(hit.page);
          else void this.mountPage(state, true).then(() => this.renderSearchMarks(hit.page));
        }
        state?.shell.classList.add("is-search-flash");
        window.setTimeout(() => state?.shell.classList.remove("is-search-flash"), 850);
      });
    }
  }

  private renderSearchMarks(pageNumber: number): void {
    const state = this.pages.get(pageNumber);
    if (!state?.mounted || !state.searchHost) return;
    const searchHost = state.searchHost;
    searchHost.empty();
    const pageHits = this.searchHitsByPage.get(pageNumber) ?? [];
    const ordered = this.activeSearchHit?.page === pageNumber
      ? [this.activeSearchHit, ...pageHits.filter(hit => hit !== this.activeSearchHit)]
      : pageHits;
    let rendered = 0;
    for (const hit of ordered) {
      for (const rect of hit.rects) {
        if (rendered >= MAX_SEARCH_RECTS_PER_PAGE) return;
        const mark = searchHost.createDiv({ cls: "lumen-search-match" });
        mark.classList.toggle("is-current", hit === this.activeSearchHit);
        mark.style.left = `${rect.x * 100}%`;
        mark.style.top = `${rect.y * 100}%`;
        mark.style.width = `${rect.width * 100}%`;
        mark.style.height = `${rect.height * 100}%`;
        rendered++;
      }
    }
  }

  private clearSearchFlashes(): void {
    this.rootEl?.querySelectorAll(".is-search-flash").forEach(element => element.classList.remove("is-search-flash"));
    this.searchHitsByPage.clear();
    this.activeSearchHit = null;
    for (const state of this.pages.values()) state.searchHost?.empty();
  }

  private closeSelectionPalette(): void {
    this.selectionPalette?.remove();
    this.selectionPalette = null;
    this.selection = null;
    window.getSelection()?.removeAllRanges();
  }

  private closeEditor(): void {
    this.editor?.remove();
    this.editor = null;
    if (this.inspector?.classList.contains("is-open")) this.refreshInspector();
  }

  private placePageNote(event: MouseEvent, state: PageState): void {
    if (!this.bundle || !state.stage) return;
    const bounds = state.stage.getBoundingClientRect();
    const markerWidth = 0.034;
    const markerHeight = markerWidth * (bounds.width / Math.max(1, bounds.height));
    const x = clamp((event.clientX - bounds.left) / bounds.width - markerWidth / 2, 0, 1 - markerWidth);
    const y = clamp((event.clientY - bounds.top) / bounds.height - markerHeight / 2, 0, 1 - markerHeight);
    const annotation = newPageNote(state.pageNumber, x, y, MARK_COLORS[0]);
    annotation.rects[0].height = markerHeight;
    this.index.put(annotation);
    this.bundle.repository.queue({ op: "put", annotation });
    this.renderMarks(state.pageNumber);
    this.refreshInspector();
    this.togglePageNotePlacement();
    const mark = state.markHost?.querySelector<HTMLElement>(`[data-annotation-id="${annotation.id}"]`);
    if (mark) this.openEditor(annotation, mark);
  }

  async importLegacyAnnotations(force = true, expectedGeneration = this.documentGeneration): Promise<number> {
    if (!this.bundle || !this.file || !this.pdfDocument) return 0;
    if (expectedGeneration !== this.documentGeneration) return 0;
    const bundle = this.bundle;
    const file = this.file;
    const pdfDocument = this.pdfDocument;
    const index = this.index;
    const markerPath = `${bundle.folder}/legacy-import-v2.json`;
    if (!force && await this.app.vault.adapter.exists(markerPath)) return 0;
    if (expectedGeneration !== this.documentGeneration) return 0;
    const records = await loadLegacyAnnotations(this.app.vault, bundle.hash, file.path);
    if (expectedGeneration !== this.documentGeneration) return 0;
    const quoteRecords = await this.loadQuoteSidecars(file, expectedGeneration);
    if (expectedGeneration !== this.documentGeneration) return 0;
    let imported = 0;
    const affectedPages = new Set<number>();
    for (const record of records) {
      if (expectedGeneration !== this.documentGeneration) return imported;
      let annotation: PdfAnnotation | null = null;
      try { annotation = await this.convertLegacyAnnotation(record, pdfDocument); } catch { /* malformed legacy geometry is skipped independently */ }
      if (expectedGeneration !== this.documentGeneration) return imported;
      if (!annotation || index.get(annotation.id)) continue;
      index.put(annotation);
      bundle.repository.queue({ op: "put", annotation });
      affectedPages.add(annotation.page);
      imported++;
      if (imported % 50 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    if (quoteRecords.length) {
      const quoteIndex = await this.buildQuoteDocumentIndex(pdfDocument, expectedGeneration);
      if (expectedGeneration !== this.documentGeneration) return imported;
      const seen = new Set(index.all().map(item => `${item.page}\u0000${this.normalizeQuote(item.quote)}`));
      for (const record of quoteRecords) {
        if (expectedGeneration !== this.documentGeneration) return imported;
        const anchors = this.anchorQuoteRecord(quoteIndex, record);
        for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex++) {
          const anchor = anchors[anchorIndex];
          const quote = record.exact.replace(/\s+/g, " ").trim();
          const duplicateKey = `${anchor.page}\u0000${this.normalizeQuote(quote)}`;
          if (seen.has(duplicateKey)) continue;
          seen.add(duplicateKey);
          const id = `legacy-quote-${this.stableKey(JSON.stringify([quote, anchor.page, anchorIndex]))}`;
          if (index.get(id)) continue;
          const annotation: PdfAnnotation = {
            id,
            kind: "text",
            page: anchor.page,
            rects: anchor.rects,
            quote,
            note: record.note ?? "",
            tags: record.tags,
            color: MARK_COLORS[0],
            style: "highlight",
            createdAt: record.createdAt,
            updatedAt: record.createdAt,
          };
          index.put(annotation);
          bundle.repository.queue({ op: "put", annotation });
          affectedPages.add(annotation.page);
          imported++;
        }
        if (imported > 0 && imported % 50 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
    }
    if (imported) await bundle.repository.checkpoint(index);
    if (expectedGeneration !== this.documentGeneration) return imported;
    await this.app.vault.adapter.write(markerPath, JSON.stringify({ imported, at: new Date().toISOString() }, null, 2));
    for (const page of affectedPages) this.renderMarks(page);
    this.refreshInspector();
    if (force) new Notice(imported ? `Imported ${imported} legacy annotation${imported === 1 ? "" : "s"}.` : "No new legacy annotations found.");
    return imported;
  }

  private async convertLegacyAnnotation(record: LegacyAnnotationRecord, pdfDocument: any): Promise<PdfAnnotation | null> {
    const zeroBasedPage = Number(record.page);
    if (!Number.isFinite(zeroBasedPage)) return null;
    const page = clamp(Math.trunc(zeroBasedPage) + 1, 1, pdfDocument.numPages);
    const style = this.legacyStyle(record.style);
    const color = typeof record.color === "string" && record.color.trim() ? record.color : MARK_COLORS[0];
    const createdAt = record.created && Number.isFinite(Date.parse(record.created)) ? Date.parse(record.created) : Date.now();
    const id = `legacy-${record.id ?? this.legacyRecordKey(record)}`;
    const note = [record.note, record.noteContentCJK].filter(Boolean).join("\n\n");
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [];
    if (record.type === "tag" || Number.isFinite(record.tagX) || Number.isFinite(record.tagY)) {
      const x = clamp((Number(record.tagX) || 0) / 100, 0, 0.966);
      const y = clamp((Number(record.tagY) || 0) / 100, 0, 0.966);
      return {
        id, kind: "page-note", page, rects: [{ x, y, width: 0.034, height: 0.034 }],
        quote: "Page note", note, tags, color, style: "comment", createdAt, updatedAt: createdAt,
      };
    }
    const pdfPage = await pdfDocument.getPage(page);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const rects: NormalizedRect[] = [];
    for (const source of record.rects ?? []) {
      const values = [source.x1, source.y1, source.x2, source.y2].map(Number);
      if (values.some(value => !Number.isFinite(value))) continue;
      const converted = viewport.convertToViewportRectangle(values);
      const left = Math.min(converted[0], converted[2]);
      const right = Math.max(converted[0], converted[2]);
      const top = Math.min(converted[1], converted[3]);
      const bottom = Math.max(converted[1], converted[3]);
      if (right <= left || bottom <= top) continue;
      rects.push({
        x: clamp(left / viewport.width, 0, 1),
        y: clamp(top / viewport.height, 0, 1),
        width: clamp((right - left) / viewport.width, 0, 1),
        height: clamp((bottom - top) / viewport.height, 0, 1),
      });
    }
    if (!rects.length) return null;
    return {
      id, kind: "text", page, rects, quote: record.text?.trim() || "Imported highlight",
      note, tags, color, style, createdAt, updatedAt: createdAt,
    };
  }

  private legacyStyle(value: string | undefined): MarkStyle {
    if (value === "underline" || value === "strike" || value === "box" || value === "comment") return value;
    if (value === "dashed" || value === "dashed-underline") return "dashed";
    if (value === "dotted" || value === "dotted-underline") return "dotted";
    return "highlight";
  }

  private legacyRecordKey(record: LegacyAnnotationRecord): string {
    return this.stableKey(JSON.stringify([record.page, record.text, record.rects, record.tagX, record.tagY]));
  }

  private stableKey(input: string): string {
    let hash = 2166136261;
    for (let index = 0; index < input.length; index++) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  private normalizeQuote(value: string): string {
    return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  }

  private async loadQuoteSidecars(file: TFile, expectedGeneration: number): Promise<QuoteAnnotationRecord[]> {
    const targetName = file.name.normalize("NFC").toLowerCase();
    const folder = this.legacyAnnotationFolder.trim().replace(/^\/+|\/+$/g, "");
    const prefix = folder ? `${folder}/`.toLowerCase() : "";
    const records: QuoteAnnotationRecord[] = [];
    for (const note of this.app.vault.getMarkdownFiles()) {
      if (expectedGeneration !== this.documentGeneration) return records;
      if (prefix && !note.path.toLowerCase().startsWith(prefix)) continue;
      const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter;
      const cachedTarget = frontmatter?.["annotation-target"];
      const target = Array.isArray(cachedTarget) ? cachedTarget[0] : cachedTarget;
      if (target !== undefined && comparableFileName(String(target)) !== targetName) continue;
      const markdown = await this.app.vault.read(note);
      if (expectedGeneration !== this.documentGeneration) return records;
      if (comparableFileName(annotationTarget(markdown)) !== targetName) continue;
      records.push(...quoteAnnotations(markdown));
      if (records.length % 50 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    return records;
  }

  private async buildQuoteDocumentIndex(pdfDocument: any, expectedGeneration: number): Promise<QuoteDocumentIndex> {
    let text = "";
    const pages: QuotePageIndex[] = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      if (expectedGeneration !== this.documentGeneration) return { text, pages };
      if (pageNumber > 1) text += "\f";
      const start = text.length;
      const page = await pdfDocument.getPage(pageNumber);
      if (expectedGeneration !== this.documentGeneration) return { text, pages };
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      if (expectedGeneration !== this.documentGeneration) return { text, pages };
      const spans: QuoteTextSpan[] = [];
      let hasText = false;
      for (const raw of content.items) {
        const item = raw as { str?: string; transform?: number[]; width?: number; height?: number };
        const value = this.normalizeQuote(item.str ?? "");
        if (!value) continue;
        if (hasText) text += " ";
        hasText = true;
        const itemStart = text.length;
        text += value;
        const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
        const x = Number(transform[4]) || 0;
        const y = Number(transform[5]) || 0;
        const width = Math.max(Number(item.width) || 0, 1);
        const height = Math.max(Number(item.height) || Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0), 1);
        const converted = viewport.convertToViewportRectangle([x, y, x + width, y + height]);
        const left = Math.min(converted[0], converted[2]);
        const right = Math.max(converted[0], converted[2]);
        const top = Math.min(converted[1], converted[3]);
        const bottom = Math.max(converted[1], converted[3]);
        spans.push({
          start: itemStart,
          end: text.length,
          rect: {
            x: clamp(left / viewport.width, 0, 1),
            y: clamp(top / viewport.height, 0, 1),
            width: clamp((right - left) / viewport.width, 0, 1),
            height: clamp((bottom - top) / viewport.height, 0, 1),
          },
        });
      }
      pages.push({ page: pageNumber, start, end: text.length, spans });
      if (pageNumber % 5 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    return { text, pages };
  }

  private anchorQuoteRecord(index: QuoteDocumentIndex, record: QuoteAnnotationRecord): Array<{ page: number; rects: NormalizedRect[] }> {
    const exact = this.normalizeQuote(record.exact);
    if (!exact) return [];
    const prefix = record.prefix ? this.normalizeQuote(record.prefix) : "";
    const suffix = record.suffix ? this.normalizeQuote(record.suffix) : "";
    const candidates: Array<{ page: number; rects: NormalizedRect[]; context: boolean }> = [];
    let from = 0;
    while (candidates.length < 500) {
      const matchStart = index.text.indexOf(exact, from);
      if (matchStart < 0) break;
      const matchEnd = matchStart + exact.length;
      const page = this.pageAtOffset(index.pages, matchStart);
      if (page && matchEnd <= page.end) {
        const rects = page.spans.filter(span => span.end > matchStart && span.start < matchEnd).map(span => {
          const overlapStart = Math.max(span.start, matchStart);
          const overlapEnd = Math.min(span.end, matchEnd);
          const length = Math.max(1, span.end - span.start);
          const startRatio = (overlapStart - span.start) / length;
          const widthRatio = (overlapEnd - overlapStart) / length;
          return { ...span.rect, x: span.rect.x + span.rect.width * startRatio, width: span.rect.width * widthRatio };
        }).filter(rect => rect.width > 0 && rect.height > 0);
        const before = index.text.slice(Math.max(page.start, matchStart - prefix.length), matchStart);
        const after = index.text.slice(matchEnd, Math.min(page.end, matchEnd + suffix.length));
        if (rects.length) candidates.push({ page: page.page, rects, context: (!prefix || before.endsWith(prefix)) && (!suffix || after.startsWith(suffix)) });
      }
      from = matchStart + Math.max(1, exact.length);
    }
    const contextual = candidates.filter(candidate => candidate.context);
    return (contextual.length ? contextual : candidates).map(({ page, rects }) => ({ page, rects }));
  }

  private pageAtOffset(pages: QuotePageIndex[], offset: number): QuotePageIndex | null {
    let low = 0;
    let high = pages.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const page = pages[middle];
      if (offset < page.start) high = middle - 1;
      else if (offset >= page.end) low = middle + 1;
      else return page;
    }
    return null;
  }

  private async teardownDocument(invalidate = true): Promise<void> {
    if (invalidate) this.documentGeneration++;
    this.observer?.disconnect();
    this.observer = null;
    this.pendingPageMounts.length = 0;
    this.queuedPageMounts.clear();
    cancelAnimationFrame(this.currentPageRaf);
    cancelAnimationFrame(this.inspectorRaf);
    window.clearTimeout(this.scrollIdleTimer);
    window.clearTimeout(this.pagePreviewTimer);
    window.clearTimeout(this.pageDetailTimer);
    this.scrollIdleTimer = 0;
    this.pagePreviewTimer = 0;
    this.pagePreviewReadyAt = 0;
    this.pageDetailTimer = 0;
    this.pageDetailReadyAt = 0;
    this.isScrolling = false;
    for (const state of this.pages.values()) {
      state.wanted = false;
      state.mounted = false;
      state.renderTask?.cancel?.();
      state.textTask?.cancel?.();
      state.renderTask = undefined;
      state.textTask = undefined;
      try { state.page?.cleanup?.(); } catch { /* page resources may already be released */ }
      state.page = undefined;
      state.renderGeneration++;
      state.textGeneration++;
      state.markGeneration++;
      if (state.markFrame) cancelAnimationFrame(state.markFrame);
      if (state.unmountTimer) window.clearTimeout(state.unmountTimer);
      if (state.textTimer) window.clearTimeout(state.textTimer);
      this.releasePageLayers(state);
    }
    this.pages.clear();
    this.mountedPages.clear();
    this.pageNotePlacement = false;
    this.pageNoteButton = null;
    this.pageTextCache.clear();
    this.pageTextCacheChars = 0;
    this.pageTextCacheSpans = 0;
    this.inspectorCache = [];
    this.inspectorCacheRevision = -1;
    this.inspectorCacheKey = "";
    this.closeSelectionPalette();
    this.finishExtension();
    this.closeEditor();
    if (this.bundle) {
      try {
        // Journal writes are incremental and bounded. A full snapshot can be
        // hundreds of megabytes for extreme annotation sets, so closing or
        // switching a PDF must never synchronously rebuild it.
        await this.bundle.repository.flushJournal();
      } catch (error) {
        console.error("Lumen could not flush annotations while closing the PDF", error);
        new Notice("Lumen could not flush recent annotation changes.", 8000);
      }
    }
    try { await this.pdfDocument?.destroy?.(); } catch { /* already gone */ }
    try { await this.pdfWorker?.destroy?.(); } catch { /* already gone */ }
    this.workerPort?.terminate();
    this.pdfDocument = null;
    this.pdfWorker = null;
    this.workerPort = null;
    this.bundle = null;
    this.index = new AnnotationIndex();
    this.contentEl.empty();
  }
}
