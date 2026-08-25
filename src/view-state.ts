import { Plugin, WorkspaceLeaf } from "obsidian";
import { LumenPdfView, LUMEN_VIEW_TYPE } from "./view";

interface PdfViewState {
  page: number;
  zoom: number;
  updatedAt: number;
}

interface PdfViewStateData {
  version: 1;
  pdfs: Record<string, PdfViewState>;
}

const SAVE_DELAY_MS = 450;
const MAX_ENTRIES = 2000;

/**
 * Persists only lightweight reader state. It deliberately never touches the
 * PDF renderer or annotation journal, so normal reading remains unaffected.
 */
export class PdfViewStateManager {
  private data: PdfViewStateData = { version: 1, pdfs: {} };
  private saveTimer: number | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private readonly attached = new WeakSet<HTMLElement>();
  private readonly cleanups = new WeakMap<HTMLElement, () => void>();

  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<void> {
    const loaded = await this.plugin.loadData() as Partial<PdfViewStateData> | null;
    const pdfs = loaded?.pdfs && typeof loaded.pdfs === "object" ? loaded.pdfs : {};
    this.data = { version: 1, pdfs: pdfs as Record<string, PdfViewState> };
  }

  attach(leaf: WorkspaceLeaf): void {
    const view = leaf.view;
    if (!(view instanceof LumenPdfView) || !view.file) return;
    const root = view.containerEl.querySelector<HTMLElement>(".lumen-reader");
    if (!root || this.attached.has(root)) return;
    this.attached.add(root);

    const path = view.file.path;
    const saved = this.data.pdfs[path];
    if (saved) this.restore(root, saved);

    let timer = 0;
    const capture = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => this.capture(view, root), SAVE_DELAY_MS);
    };
    root.querySelector(".lumen-scroll")?.addEventListener("scroll", capture, { passive: true });
    root.querySelector(".lumen-page-input")?.addEventListener("change", capture);
    root.querySelectorAll(".lumen-zoom-group .lumen-icon-button").forEach(button => button.addEventListener("click", capture));

    let cleanup: () => void;
    const host = root.parentElement;
    const mutationObserver = host ? new MutationObserver(() => {
      if (!document.contains(root)) cleanup();
    }) : null;
    mutationObserver?.observe(host!, { childList: true, subtree: true });

    cleanup = () => {
      window.clearTimeout(timer);
      this.capture(view, root);
      root.querySelector(".lumen-scroll")?.removeEventListener("scroll", capture);
      root.querySelector(".lumen-page-input")?.removeEventListener("change", capture);
      root.querySelectorAll(".lumen-zoom-group .lumen-icon-button").forEach(button => button.removeEventListener("click", capture));
      mutationObserver?.disconnect();
      this.cleanups.delete(root);
    };
    this.cleanups.set(root, cleanup);
  }

  attachAll(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(LUMEN_VIEW_TYPE)) this.attach(leaf);
  }

  detachAll(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(LUMEN_VIEW_TYPE)) {
      const root = leaf.view.containerEl.querySelector<HTMLElement>(".lumen-reader");
      if (root) this.cleanups.get(root)?.();
    }
  }

  private restore(root: HTMLElement, state: PdfViewState): void {
    const zoomLabel = root.querySelector<HTMLElement>(".lumen-zoom-label");
    const pageInput = root.querySelector<HTMLInputElement>(".lumen-page-input");
    const zoom = Math.max(0.5, Math.min(4, Math.round(state.zoom * 4) / 4));
    const page = Math.max(1, Math.round(state.page));
    const currentZoom = Number.parseInt(zoomLabel?.textContent ?? "125", 10) / 100;
    const delta = Math.round((zoom - currentZoom) * 4);
    if (delta !== 0) {
      const buttons = root.querySelectorAll<HTMLButtonElement>(".lumen-zoom-group .lumen-icon-button");
      const button = delta > 0 ? buttons[1] : buttons[0];
      for (let i = 0; i < Math.abs(delta); i++) button?.click();
    }
    if (pageInput) pageInput.value = String(page);
    window.setTimeout(() => {
      const input = root.querySelector<HTMLInputElement>(".lumen-page-input");
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    }, 0);
  }

  private capture(view: LumenPdfView, root: HTMLElement): void {
    const path = view.file?.path;
    if (!path) return;
    const page = Number.parseInt(root.querySelector<HTMLInputElement>(".lumen-page-input")?.value ?? "1", 10);
    const zoom = Number.parseInt(root.querySelector<HTMLElement>(".lumen-zoom-label")?.textContent ?? "125", 10) / 100;
    if (!Number.isFinite(page) || !Number.isFinite(zoom)) return;
    this.data.pdfs[path] = { page: Math.max(1, page), zoom: Math.max(0.5, Math.min(4, zoom)), updatedAt: Date.now() };
    const entries = Object.entries(this.data.pdfs)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_ENTRIES);
    this.data.pdfs = Object.fromEntries(entries);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const snapshot = this.data;
      this.saveChain = this.saveChain.catch(() => undefined).then(() => this.plugin.saveData(snapshot));
    }, SAVE_DELAY_MS);
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveChain = this.saveChain.catch(() => undefined).then(() => this.plugin.saveData(this.data));
    await this.saveChain;
  }
}
