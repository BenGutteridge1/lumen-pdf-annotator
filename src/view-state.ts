import { Plugin, WorkspaceLeaf } from "obsidian";
import { LumenPdfView, LUMEN_VIEW_TYPE } from "./view";

interface PdfViewState {
  page: number;
  zoom: number;
  updatedAt: number;
  mobileFit?: boolean;
}

interface PdfViewStateData {
  version: 1;
  pdfs: Record<string, PdfViewState>;
}

interface PluginDataWithViewState {
  pdfViewState?: Partial<PdfViewStateData>;
  [key: string]: unknown;
}

const SAVE_DELAY_MS = 450;
const MAX_ENTRIES = 2000;

function stateKey(view: LumenPdfView, path: string): string {
  // Mobile zoom is normally fit-to-width and must not overwrite the desktop
  // reader position when Obsidian Sync carries plugin data between devices.
  return view.isMobileView() ? `mobile:${path}` : path;
}

/**
 * Persists only lightweight reader state. It deliberately never touches the
 * PDF renderer or annotation journal, so normal reading remains unaffected.
 */
export class PdfViewStateManager {
  private data: PdfViewStateData = { version: 1, pdfs: {} };
  private saveTimer: number | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private readonly attached = new WeakSet<HTMLElement>();
  private readonly pendingRestores = new WeakMap<HTMLElement, () => void>();
  private readonly activeCaptures = new Map<HTMLElement, () => void>();

  constructor(
    private readonly plugin: Plugin,
    private readonly persist: (state: PdfViewStateData) => Promise<void>,
  ) {}

  async load(): Promise<void> {
    const loaded: unknown = await this.plugin.loadData() as unknown;
    const data = typeof loaded === "object" && loaded !== null && !Array.isArray(loaded)
      ? loaded as PluginDataWithViewState
      : null;
    const stored = data?.pdfViewState;
    const pdfs = stored?.pdfs && typeof stored.pdfs === "object" ? stored.pdfs : {};
    this.data = { version: 1, pdfs };
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
      return;
    }
    const scroll = root.querySelector<HTMLElement>(".lumen-scroll");
    if (!scroll) return;
    this.attached.add(root);
    const path = view.file.path;
    const zoomButtons = root.querySelectorAll(".lumen-zoom-group .lumen-icon-button");
    const pageInput = root.querySelector(".lumen-page-input");

    const saved = this.data.pdfs[stateKey(view, path)];
    let timer = 0;
    let listening = false;
    let disposed = false;
    let restoring = false;
    let resizeObserver: ResizeObserver | null = null;
    const captureLater = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => this.capture(view, root, path), SAVE_DELAY_MS);
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
      scroll.addEventListener("scroll", captureLater, { passive: true });
      pageInput?.addEventListener("change", captureLater);
      zoomButtons.forEach(button => button.addEventListener("click", captureLater));
      this.activeCaptures.set(root, captureNow);
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
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      this.pendingRestores.delete(root);
      this.activeCaptures.delete(root);
      this.attached.delete(root);
    };
    if (!saved) {
      startListening();
      return;
    }

    const attemptRestore = () => {
      if (disposed || listening || restoring || !root.isConnected || view.file?.path !== path) return;
      if (root.clientWidth < 1 || scroll.clientHeight < 1
        || root.ownerDocument.defaultView?.getComputedStyle(root).visibility === "hidden") return;
      restoring = true;
      void this.restore(view, root, saved).then(restored => {
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

  private async restore(view: LumenPdfView, root: HTMLElement, state: PdfViewState): Promise<boolean> {
    const zoomLabel = root.querySelector<HTMLElement>(".lumen-zoom-label");
    const savedZoom = Number.isFinite(state.zoom) ? state.zoom : 1.25;
    const roundedZoom = view.isMobileView() ? Math.round(savedZoom * 20) / 20 : Math.round(savedZoom * 4) / 4;
    const desiredZoom = Math.max(view.minimumZoom(), Math.min(4, roundedZoom));
    const page = Math.max(1, Math.round(Number.isFinite(state.page) ? state.page : 1));
    const currentZoom = Number.parseInt(zoomLabel?.textContent ?? "125", 10) / 100;
    if (view.isMobileView() || Math.abs(desiredZoom - currentZoom) >= 0.001) {
      await view.restoreZoom(desiredZoom, Boolean(state.mobileFit));
    }
    const scroll = root.querySelector<HTMLElement>(".lumen-scroll");
    if (!root.isConnected || !root.clientWidth || !scroll?.clientHeight
      || root.ownerDocument.defaultView?.getComputedStyle(root).visibility === "hidden") return false;
    view.restorePage(page);
    return true;
  }

  private capture(view: LumenPdfView, root: HTMLElement, path: string, allowDetached = false): void {
    const scroll = root.querySelector<HTMLElement>(".lumen-scroll");
    if (!allowDetached && (!root.isConnected || !root.clientWidth || !scroll?.clientHeight
      || root.ownerDocument.defaultView?.getComputedStyle(root).visibility === "hidden")) return;
    const page = Number.parseInt(root.querySelector<HTMLInputElement>(".lumen-page-input")?.value ?? "1", 10);
    const zoom = Number.parseInt(root.querySelector<HTMLElement>(".lumen-zoom-label")?.textContent ?? "125", 10) / 100;
    if (!Number.isFinite(page) || !Number.isFinite(zoom)) return;
    this.data.pdfs[stateKey(view, path)] = {
      page: Math.max(1, page),
      zoom: Math.max(view.minimumZoom(), Math.min(4, zoom)),
      updatedAt: Date.now(),
      mobileFit: view.usesMobileFit() || undefined,
    };
    this.data.pdfs = Object.fromEntries(Object.entries(this.data.pdfs)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_ENTRIES));
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveChain = this.saveChain.catch(() => undefined).then(() => this.writeMergedData());
    }, SAVE_DELAY_MS);
  }

  private async writeMergedData(): Promise<void> {
    await this.persist({ version: 1, pdfs: { ...this.data.pdfs } });
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
