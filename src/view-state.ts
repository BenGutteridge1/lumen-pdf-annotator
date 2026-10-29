import { Plugin, WorkspaceLeaf } from "obsidian";
import { LumenPdfView, LUMEN_VIEW_TYPE } from "./view";
import { newerPosition, readingPosition, ReadingPosition, ReadingPositionStore } from "./reading-position";

interface PdfZoomState {
  zoom: number;
  mobileFit?: boolean;
}

interface PdfViewStateData {
  version: 2;
  pdfs: Record<string, PdfZoomState>;
}

interface PluginDataWithViewState {
  pdfViewState?: Partial<PdfViewStateData>;
  [key: string]: unknown;
}

const SAVE_DELAY_MS = 450;
const MAX_ENTRIES = 2000;

function zoomKey(view: LumenPdfView, path: string): string {
  // Preserve independent device zoom preferences in local plugin settings.
  return view.isMobileView() ? `mobile:${path}` : path;
}

/**
 * Persists only lightweight reader state. It deliberately never touches the
 * PDF renderer or annotation journal, so normal reading remains unaffected.
 */
export class PdfViewStateManager {
  private data: PdfViewStateData = { version: 2, pdfs: {} };
  private saveTimer: number | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private readonly attached = new WeakSet<HTMLElement>();
  private readonly pendingRestores = new WeakMap<HTMLElement, () => void>();
  private readonly activeCaptures = new Map<HTMLElement, () => void>();
  private readonly lastPages = new WeakMap<HTMLElement, number>();
  private readonly pageTimes = new WeakMap<HTMLElement, number>();
  private readonly refreshPositions = new WeakMap<HTMLElement, () => void>();
  private readonly documentHashes = new WeakMap<HTMLElement, string>();
  private readonly positions = new Map<string, ReadingPosition>();
  private readonly pendingPositions = new Map<string, ReadingPosition>();
  private readonly legacyPositions = new Map<string, ReadingPosition>();
  private readonly positionStore: ReadingPositionStore | null;

  constructor(
    private readonly plugin: Plugin,
    private readonly persist: (state: PdfViewStateData) => Promise<void>,
  ) {
    this.positionStore = plugin.app?.vault ? new ReadingPositionStore(plugin.app.vault) : null;
  }

  async load(): Promise<void> {
    const loaded: unknown = await this.plugin.loadData() as unknown;
    const data = typeof loaded === "object" && loaded !== null && !Array.isArray(loaded)
      ? loaded as PluginDataWithViewState
      : null;
    const stored = data?.pdfViewState;
    const pdfs = stored?.pdfs && typeof stored.pdfs === "object" ? stored.pdfs : {};
    const zooms: Record<string, PdfZoomState> = {};
    for (const [key, raw] of Object.entries(pdfs)) {
      if (!raw || typeof raw !== "object") continue;
      const state = raw as Partial<PdfZoomState & ReadingPosition>;
      if (Number.isFinite(state.zoom)) zooms[key] = { zoom: state.zoom!, mobileFit: state.mobileFit === true || undefined };
      const position = readingPosition(state);
      if (position) {
        const path = key.startsWith("mobile:") ? key.slice("mobile:".length) : key;
        this.legacyPositions.set(path, newerPosition(this.legacyPositions.get(path) ?? null, position)!);
      }
    }
    this.data = { version: 2, pdfs: zooms };
  }

  attach(leaf: WorkspaceLeaf): void {
    const view = leaf.view;
    if (!(view instanceof LumenPdfView) || !view.file || !view.isReaderReady()) return;
    const root = view.containerEl.querySelector<HTMLElement>(".lumen-reader");
    if (!root) return;
    if (this.attached.has(root)) {
      const pending = this.pendingRestores.get(root);
      pending?.();
      if (pending) window.setTimeout(pending, 80);
      else this.refreshPositions.get(root)?.();
      return;
    }
    const scroll = root.querySelector<HTMLElement>(".lumen-scroll");
    if (!scroll) return;
    this.attached.add(root);
    const path = view.file.path;
    const zoomButtons = root.querySelectorAll(".lumen-zoom-group .lumen-icon-button");
    const pageInput = root.querySelector(".lumen-page-input");

    const savedZoom = this.data.pdfs[zoomKey(view, path)];
    let savedPosition: ReadingPosition | null = null;
    const hash = view.getDocumentHash();
    if (hash) this.documentHashes.set(root, hash);
    let positionLoaded = false;
    let timer = 0;
    let listening = false;
    let disposed = false;
    let restoring = false;
    let resizeObserver: ResizeObserver | null = null;
    const captureLater = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        this.capture(view, root, path);
      }, SAVE_DELAY_MS);
    };
    const captureNow = (allowDetached = false) => {
      window.clearTimeout(timer);
      timer = 0;
      this.capture(view, root, path, allowDetached);
    };
    const startListening = () => {
      if (disposed || listening) return;
      listening = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      this.pendingRestores.delete(root);
      this.lastPages.set(root, Number.parseInt(root.querySelector<HTMLInputElement>(".lumen-page-input")?.value ?? "1", 10));
      this.pageTimes.set(root, savedPosition?.updatedAt ?? 0);
      scroll.addEventListener("scroll", captureLater, { passive: true });
      pageInput?.addEventListener("change", captureLater);
      zoomButtons.forEach(button => button.addEventListener("click", captureLater));
      root.addEventListener("lumen-zoom-change", captureLater);
      this.activeCaptures.set(root, captureNow);
      let refreshing = false;
      this.refreshPositions.set(root, () => {
        if (refreshing || disposed || timer || !hash || !this.positionStore || !view.canRestoreReadingPosition()) return;
        const currentPage = Number.parseInt(root.querySelector<HTMLInputElement>(".lumen-page-input")?.value ?? "1", 10);
        if (this.lastPages.get(root) !== currentPage) return;
        const pageTime = this.pageTimes.get(root) ?? 0;
        refreshing = true;
        void this.positionStore.read(hash).then(async position => {
          if (!position || position.updatedAt <= pageTime || disposed || timer || !view.canRestoreReadingPosition()
            || this.pageTimes.get(root) !== pageTime || view.file?.path !== path
            || Number.parseInt(root.querySelector<HTMLInputElement>(".lumen-page-input")?.value ?? "1", 10) !== currentPage) return;
          const restored = await this.restore(view, root, { zoom: view.currentZoom(), mobileFit: view.usesMobileFit() }, position);
          if (restored) {
            this.positions.set(hash, position);
            this.lastPages.set(root, position.page);
            this.pageTimes.set(root, position.updatedAt);
          }
        }).catch(error => console.warn("Lumen could not refresh the shared PDF page", error))
          .finally(() => { refreshing = false; });
      });
    };

    let cleanup = () => {};
    const host = root.parentElement;
    const mutationObserver = host ? new MutationObserver(() => {
      if (!root.ownerDocument.contains(root)) cleanup();
    }) : null;
    mutationObserver?.observe(host!, { childList: true });

    cleanup = () => {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(timer);
      if (listening) captureNow(true);
      scroll.removeEventListener("scroll", captureLater);
      pageInput?.removeEventListener("change", captureLater);
      zoomButtons.forEach(button => button.removeEventListener("click", captureLater));
      root.removeEventListener("lumen-zoom-change", captureLater);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      this.pendingRestores.delete(root);
      this.activeCaptures.delete(root);
      this.attached.delete(root);
      this.refreshPositions.delete(root);
    };
    const attemptRestore = () => {
      if (disposed || listening || restoring || !root.isConnected || view.file?.path !== path) return;
      if (root.clientWidth < 1 || scroll.clientHeight < 1
        || root.ownerDocument.defaultView?.getComputedStyle(root).visibility === "hidden") return;
      restoring = true;
      void (async () => {
        if (!positionLoaded) {
          // Migrate old plugin settings and 1.0.27 sidecars, without borrowing
          // their zoom. New state lives beside each PDF's annotation bundle.
          const legacyPosition = this.legacyPositions.get(path) ?? null;
          let storedPosition: ReadingPosition | null = null;
          let sidecarPosition: ReadingPosition | null = null;
          if (hash && this.positionStore) {
            try {
              storedPosition = await this.positionStore.read(hash);
              if (!storedPosition) sidecarPosition = await this.positionStore.readLegacy(hash);
            }
            catch (error) { console.warn("Lumen could not read the shared PDF page", error); }
            const position = newerPosition(storedPosition, newerPosition(sidecarPosition, legacyPosition));
            if (position) {
              this.positions.set(hash, position);
              if (!storedPosition || position.updatedAt > storedPosition.updatedAt) {
                this.pendingPositions.set(hash, position);
                this.scheduleSave();
              }
            }
            savedPosition = newerPosition(storedPosition, newerPosition(sidecarPosition, legacyPosition));
          } else {
            savedPosition = legacyPosition;
          }
          positionLoaded = true;
        }
        if (!savedPosition && !savedZoom) return true;
        if (disposed || view.file?.path !== path) return false;
        if (savedPosition) this.pageTimes.set(root, savedPosition.updatedAt);
        return this.restore(view, root, savedZoom ?? { zoom: view.currentZoom(), mobileFit: view.usesMobileFit() }, savedPosition);
      })().then(restored => {
        restoring = false;
        if (!disposed && restored && view.file?.path === path) startListening();
      }).catch(error => {
        restoring = false;
        console.warn("Lumen could not restore PDF view state", error);
      });
    };
    this.pendingRestores.set(root, attemptRestore);
    resizeObserver = new ResizeObserver(attemptRestore);
    resizeObserver.observe(root);
    attemptRestore();
  }

  attachAll(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(LUMEN_VIEW_TYPE)) this.attach(leaf);
  }

  private async restore(view: LumenPdfView, root: HTMLElement, state: PdfZoomState, position: ReadingPosition | null): Promise<boolean> {
    const savedZoom = Number.isFinite(state.zoom) ? state.zoom : 1.25;
    const roundedZoom = view.isMobileView() ? Math.round(savedZoom * 20) / 20 : Math.round(savedZoom * 100) / 100;
    const desiredZoom = Math.max(view.minimumZoom(), Math.min(4, roundedZoom));
    const currentZoom = view.currentZoom();
    if (view.isMobileView() || Math.abs(desiredZoom - currentZoom) >= 0.001) {
      await view.restoreZoom(desiredZoom, Boolean(state.mobileFit));
    }
    const scroll = root.querySelector<HTMLElement>(".lumen-scroll");
    if (!root.isConnected || !root.clientWidth || !scroll?.clientHeight
      || root.ownerDocument.defaultView?.getComputedStyle(root).visibility === "hidden") return false;
    if (position) view.restorePage(position.page);
    return true;
  }

  private capture(view: LumenPdfView, root: HTMLElement, path: string, allowDetached = false): void {
    const scroll = root.querySelector<HTMLElement>(".lumen-scroll");
    if (!allowDetached && (!root.isConnected || !root.clientWidth || !scroll?.clientHeight
      || root.ownerDocument.defaultView?.getComputedStyle(root).visibility === "hidden")) return;
    const page = Number.parseInt(root.querySelector<HTMLInputElement>(".lumen-page-input")?.value ?? "1", 10);
    const zoom = Math.round(view.currentZoom(root) * 100) / 100;
    if (!Number.isFinite(page) || !Number.isFinite(zoom)) return;
    const key = zoomKey(view, path);
    const changedPage = this.lastPages.has(root) && this.lastPages.get(root) !== page;
    this.lastPages.set(root, page);
    const hash = this.documentHashes.get(root) ?? view.getDocumentHash();
    const position = hash ? this.positions.get(hash) : null;
    const updatedAt = changedPage ? Math.max(Date.now(), (position?.updatedAt ?? 0) + 1, (this.pageTimes.get(root) ?? 0) + 1) : this.pageTimes.get(root) ?? 0;
    this.pageTimes.set(root, updatedAt);
    if (changedPage && hash) {
      const next = { page: Math.max(1, page), updatedAt };
      this.positions.set(hash, next);
      this.pendingPositions.set(hash, next);
    }
    this.data.pdfs[key] = {
      zoom: Math.max(view.minimumZoom(), Math.min(4, zoom)),
      mobileFit: view.usesMobileFit() || undefined,
    };
    const updatedZoom = this.data.pdfs[key];
    delete this.data.pdfs[key];
    this.data.pdfs[key] = updatedZoom;
    const entries = Object.entries(this.data.pdfs);
    if (entries.length > MAX_ENTRIES) this.data.pdfs = Object.fromEntries(entries.slice(-MAX_ENTRIES));
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveChain = this.saveChain.catch(() => undefined).then(() => this.writeMergedData());
      void this.saveChain.catch(error => console.warn("Lumen could not save PDF reading state", error));
    }, SAVE_DELAY_MS);
  }

  private async writeMergedData(): Promise<void> {
    for (const [hash, position] of this.pendingPositions) {
      if (!this.positionStore) break;
      const stored = await this.positionStore.save(hash, position);
      this.positions.set(hash, newerPosition(this.positions.get(hash) ?? null, stored)!);
      if (this.pendingPositions.get(hash) === position) this.pendingPositions.delete(hash);
    }
    await this.persist({ version: 2, pdfs: { ...this.data.pdfs } });
  }

  async flush(): Promise<void> {
    for (const capture of this.activeCaptures.values()) capture();
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveChain = this.saveChain.catch(() => undefined).then(() => this.writeMergedData());
    await this.saveChain;
  }
}
