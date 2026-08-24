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
const MAX_DOM_MARK_RECTS = 400;
const MARK_RECTS_PER_FRAME = 1_200;
const MARK_HIT_GRID_SIZE = 32;

interface PageState {
  pageNumber: number;
  shell: HTMLElement;
  stage: HTMLElement;
  canvasHost: HTMLElement;
  searchHost: HTMLElement;
  textHost: HTMLElement;
  markHost: HTMLElement;
  page?: any;
  renderTask?: any;
  textTask?: any;
  mounted: boolean;
  unmountTimer?: number;
  renderGeneration: number;
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
    const bundle = await openBundle(this.app.vault, file, bytes);
    if (generation !== this.documentGeneration) return;
    const loaded = await loadPdf(bytes);
    if (generation !== this.documentGeneration) {
      try { await loaded.document?.destroy?.(); } catch { /* a newer document owns the view */ }
      try { await loaded.worker?.destroy?.(); } catch { /* already gone */ }
      loaded.port.terminate();
      return;
    }
    this.bundle = bundle;
    this.index = bundle.index;
    this.pdfDocument = loaded.document;
    this.pdfWorker = loaded.worker;
    this.workerPort = loaded.port;
    this.buildShell(file);
    await this.buildPages(generation);
    if (generation !== this.documentGeneration) return;
    await this.importLegacyAnnotations(false, generation);
    if (generation !== this.documentGeneration) return;
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
    if (state && !state.mounted) await this.mountPage(state);
    window.setTimeout(() => {
      this.flashAnnotation(this.index.groupId(target));
      const mark = state?.markHost.querySelector<HTMLElement>(`[data-annotation-id="${target.id}"]`);
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
    this.scrollEl.addEventListener("mouseup", event => {
      if (this.suppressNextSelectionCapture) {
        this.suppressNextSelectionCapture = false;
        return;
      }
      this.captureSelection(event);
    });
    this.scrollEl.addEventListener("scroll", () => {
      cancelAnimationFrame(this.currentPageRaf);
      this.currentPageRaf = requestAnimationFrame(() => this.updateCurrentPage());
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
    const pageCount = this.pdfDocument.numPages;
    (this.toolbarEl as any)._pageTotal.textContent = String(pageCount);
    this.observer = new IntersectionObserver(entries => {
      if (generation !== this.documentGeneration) return;
      for (const entry of entries) {
        const state = this.pages.get(Number((entry.target as HTMLElement).dataset.page));
        if (!state) continue;
        if (entry.isIntersecting) {
          if (state.unmountTimer) window.clearTimeout(state.unmountTimer);
          void this.mountPage(state).catch(error => {
            state.mounted = false;
            this.mountedPages.delete(state);
            state.renderGeneration++;
            state.canvasHost.empty();
            state.searchHost.empty();
            state.textHost.empty();
            state.markHost.empty();
            state.markHitGrid = undefined;
            state.markWideHits = undefined;
            console.warn(`Lumen could not render PDF page ${state.pageNumber}`, error);
          });
        } else if (state.mounted) {
          state.unmountTimer = window.setTimeout(() => this.unmountIfFar(state), 1200);
        }
      }
    }, { root: this.scrollEl, rootMargin: "900px 0px 900px", threshold: 0.01 });

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      if (generation !== this.documentGeneration) return;
      const shell = this.pagesEl.createDiv({ cls: "lumen-page" });
      shell.dataset.page = String(pageNumber);
      const stage = shell.createDiv({ cls: "lumen-page-stage" });
      const canvasHost = stage.createDiv({ cls: "lumen-canvas-layer" });
      const searchHost = stage.createDiv({ cls: "lumen-search-layer" });
      const textHost = stage.createDiv({ cls: "lumen-text-layer" });
      const markHost = stage.createDiv({ cls: "lumen-mark-layer" });
      const state: PageState = {
        pageNumber, shell, stage, canvasHost, searchHost, textHost, markHost,
        mounted: false, renderGeneration: 0, markGeneration: 0,
      };
      this.pages.set(pageNumber, state);
      stage.addEventListener("click", event => {
        if (this.pageNotePlacement) {
          event.preventDefault();
          event.stopPropagation();
          this.placePageNote(event, state);
          return;
        }
        this.openDenseAnnotationAtPoint(event, state);
      });
      stage.addEventListener("contextmenu", event => this.openDenseAnnotationMenuAtPoint(event, state));
      this.sizePage(state, this.baselineWidth, this.baselineHeight);
      this.observer.observe(shell);
      if (pageNumber % 250 === 0) {
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        if (generation !== this.documentGeneration) return;
      }
    }
  }

  private sizePage(state: PageState, width: number, height: number): void {
    state.stage.style.setProperty("--lumen-page-width", `${width}px`);
    state.stage.style.setProperty("--lumen-page-height", `${height}px`);
  }

  private async mountPage(state: PageState): Promise<void> {
    if (!this.pdfDocument || state.mounted) return;
    state.mounted = true;
    this.mountedPages.add(state);
    const generation = ++state.renderGeneration;
    const page = state.page ?? await this.pdfDocument.getPage(state.pageNumber);
    if (!state.mounted || generation !== state.renderGeneration) return;
    state.page = page;
    const cssViewport = page.getViewport({ scale: this.zoom });
    this.sizePage(state, cssViewport.width / this.zoom, cssViewport.height / this.zoom);
    state.canvasHost.empty();
    state.textHost.empty();
    const canvas = document.createElement("canvas");
    state.canvasHost.append(canvas);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const desiredPixels = cssViewport.width * cssViewport.height * dpr * dpr;
    const pixelFactor = desiredPixels > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / desiredPixels) : 1;
    const renderScale = this.zoom * dpr * pixelFactor;
    const renderViewport = page.getViewport({ scale: renderScale });
    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    canvas.style.width = `${cssViewport.width}px`;
    canvas.style.height = `${cssViewport.height}px`;
    state.renderTask = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: renderViewport });
    try { await state.renderTask.promise; } catch { /* cancelled during zoom/unload */ }
    if (!state.mounted || generation !== state.renderGeneration) return;
    try {
      const textContent = await page.getTextContent();
      const textLayer = new (await import("pdfjs-dist/build/pdf.mjs") as any).TextLayer({
        textContentSource: textContent,
        container: state.textHost,
        viewport: cssViewport,
      });
      state.textTask = textLayer;
      await textLayer.render();
    } catch { /* malformed text layers should not block the page */ }
    if (!state.mounted || generation !== state.renderGeneration) return;
    this.renderSearchMarks(state.pageNumber);
    this.renderMarks(state.pageNumber);
  }

  private unmountIfFar(state: PageState): void {
    const root = this.scrollEl.getBoundingClientRect();
    const rect = state.shell.getBoundingClientRect();
    if (rect.bottom > root.top - 1800 && rect.top < root.bottom + 1800) return;
    state.renderTask?.cancel?.();
    state.textTask?.cancel?.();
    state.renderGeneration++;
    state.markGeneration++;
    if (state.markFrame) cancelAnimationFrame(state.markFrame);
    state.canvasHost.empty();
    state.searchHost.empty();
    state.textHost.empty();
    state.markHost.empty();
    state.markHitGrid = undefined;
    state.markWideHits = undefined;
    state.mounted = false;
    this.mountedPages.delete(state);
  }

  private async setZoom(value: number): Promise<void> {
    this.zoom = clamp(Math.round(value * 4) / 4, 0.5, 4);
    this.rootEl.style.setProperty("--lumen-zoom", String(this.zoom));
    (this.toolbarEl as any)._zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    for (const state of Array.from(this.mountedPages)) {
      state.renderTask?.cancel?.();
      state.textTask?.cancel?.();
      state.renderGeneration++;
      state.markGeneration++;
      if (state.markFrame) cancelAnimationFrame(state.markFrame);
      state.mounted = false;
      this.mountedPages.delete(state);
      await this.mountPage(state);
    }
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
      if (!state) continue;
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
      const mark = this.pages.get(first.page)?.markHost.querySelector<HTMLElement>(`[data-annotation-id="${first.id}"]`);
      if (mark) this.openEditor(first, mark);
    }
  }

  private renderMarks(pageNumber: number): void {
    const state = this.pages.get(pageNumber);
    if (!state || !state.mounted) return;
    state.markGeneration++;
    if (state.markFrame) cancelAnimationFrame(state.markFrame);
    state.markFrame = undefined;
    state.markHitGrid = undefined;
    state.markWideHits = undefined;
    state.markHost.empty();
    const annotations = this.index.onPage(pageNumber);
    const rectCount = annotations.reduce((total, annotation) => total + annotation.rects.length, 0);
    if (rectCount > MAX_DOM_MARK_RECTS) {
      this.renderDenseMarks(state, annotations, state.markGeneration);
      return;
    }
    for (const annotation of annotations) {
      for (const rect of annotation.rects) {
        const mark = state.markHost.createDiv({ cls: `lumen-mark style-${annotation.style}` });
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
        mark.addEventListener("pointerdown", event => event.stopPropagation());
        mark.addEventListener("contextmenu", event => {
          event.preventDefault();
          event.stopPropagation();
          this.showAnnotationMenu(event, annotation);
        });
        mark.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          this.openEditor(annotation, mark);
        });
      }
    }
  }

  private renderDenseMarks(state: PageState, annotations: PdfAnnotation[], generation: number): void {
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
      while (annotationIndex < annotations.length && drawn < MARK_RECTS_PER_FRAME) {
        const annotation = annotations[annotationIndex];
        while (rectIndex < annotation.rects.length && drawn < MARK_RECTS_PER_FRAME) {
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
    if (!grid || !state.mounted) return null;
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
    const stage = state.stage.getBoundingClientRect();
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

  private refreshInspector(skipLayoutRead = false): void {
    if (!this.inspectorList) return;
    this.annotationCount.textContent = String(this.index.logicalSize);
    if (!this.inspector.classList.contains("is-open")) {
      this.inspectorList.empty();
      this.inspector.querySelector(".lumen-inspector-detail")?.remove();
      return;
    }
    if (!skipLayoutRead) {
      const virtualHeight = this.inspectorVirtualHeight(this.filteredAnnotations().length);
      this.inspectorList.scrollTop = Math.min(this.inspectorList.scrollTop, Math.max(0, virtualHeight - this.inspectorList.clientHeight));
    }
    this.renderInspectorWindow(skipLayoutRead ? 500 : undefined, skipLayoutRead ? 0 : undefined);
  }

  private inspectorVirtualHeight(itemCount: number): number {
    return Math.min(itemCount * CARD_HEIGHT, MAX_INSPECTOR_SCROLL_HEIGHT);
  }

  private renderInspectorWindow(viewportOverride?: number, scrollTopOverride?: number): void {
    const items = this.filteredAnnotations();
    // Read current layout before replacing the window. Initial opening passes
    // explicit values, so it performs no synchronous layout reads at all.
    const scrollTop = scrollTopOverride ?? this.inspectorList.scrollTop;
    this.inspectorList.empty();
    if (!items.length) {
      this.inspectorList.createDiv({ cls: "lumen-empty", text: "No matching annotations" });
      return;
    }
    const viewport = (viewportOverride ?? this.inspectorList.clientHeight) || 500;
    const logicalHeight = items.length * CARD_HEIGHT;
    const virtualHeight = this.inspectorVirtualHeight(items.length);
    const visibleCount = Math.max(1, Math.ceil(viewport / CARD_HEIGHT));
    const maxAnchor = Math.max(0, items.length - visibleCount);
    const scrollRange = Math.max(1, virtualHeight - viewport);
    const anchor = logicalHeight <= virtualHeight
      ? Math.floor(scrollTop / CARD_HEIGHT)
      : Math.round((scrollTop / scrollRange) * maxAnchor);
    const start = Math.max(0, anchor - CARD_OVERSCAN);
    const end = Math.min(items.length, anchor + visibleCount + CARD_OVERSCAN);
    const spacer = this.inspectorList.createDiv({ cls: "lumen-virtual-spacer" });
    spacer.style.height = `${virtualHeight}px`;
    const window = spacer.createDiv({ cls: "lumen-virtual-window" });
    const windowHeight = (end - start) * CARD_HEIGHT;
    const windowTop = logicalHeight <= virtualHeight
      ? start * CARD_HEIGHT
      : clamp(scrollTop - CARD_OVERSCAN * CARD_HEIGHT, 0, Math.max(0, virtualHeight - windowHeight));
    window.style.transform = `translateY(${windowTop}px)`;
    for (let i = start; i < end; i++) {
      const item = items[i];
      const card = window.createDiv({ cls: "lumen-annotation-card" });
      card.style.top = `${(i - start) * CARD_HEIGHT + 4}px`;
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
    if (cached !== undefined) return cached;
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
    if (this.pageTextCacheChars + text.length <= MAX_SEARCH_CACHE_CHARS
      && this.pageTextCacheSpans + spans.length <= MAX_SEARCH_CACHE_SPANS) {
      this.pageTextCache.set(pageNumber, data);
      this.pageTextCacheChars += text.length;
      this.pageTextCacheSpans += spans.length;
    }
    return data;
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
          if (state.mounted) this.renderSearchMarks(hit.page);
          else void this.mountPage(state).then(() => this.renderSearchMarks(hit.page));
        }
        state?.shell.classList.add("is-search-flash");
        window.setTimeout(() => state?.shell.classList.remove("is-search-flash"), 850);
      });
    }
  }

  private renderSearchMarks(pageNumber: number): void {
    const state = this.pages.get(pageNumber);
    if (!state || !state.mounted) return;
    state.searchHost.empty();
    const pageHits = this.searchHitsByPage.get(pageNumber) ?? [];
    const ordered = this.activeSearchHit?.page === pageNumber
      ? [this.activeSearchHit, ...pageHits.filter(hit => hit !== this.activeSearchHit)]
      : pageHits;
    let rendered = 0;
    for (const hit of ordered) {
      for (const rect of hit.rects) {
        if (rendered >= MAX_SEARCH_RECTS_PER_PAGE) return;
        const mark = state.searchHost.createDiv({ cls: "lumen-search-match" });
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
    for (const state of this.pages.values()) state.searchHost.empty();
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
    if (!this.bundle) return;
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
    const mark = state.markHost.querySelector<HTMLElement>(`[data-annotation-id="${annotation.id}"]`);
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
    cancelAnimationFrame(this.currentPageRaf);
    cancelAnimationFrame(this.inspectorRaf);
    for (const state of this.pages.values()) {
      state.renderTask?.cancel?.();
      state.textTask?.cancel?.();
      if (state.unmountTimer) window.clearTimeout(state.unmountTimer);
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
        await this.bundle.repository.checkpoint(this.index);
      } catch (error) {
        console.error("Lumen could not checkpoint annotations while closing the PDF", error);
        new Notice("Lumen could not save an annotation checkpoint. Recent journal data was retained.", 8000);
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
