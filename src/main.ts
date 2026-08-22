import {
  FuzzySuggestModal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import {
  PdfAnnotatorView,
  VIEW_TYPE_PDF_ANNOTATOR,
  type PdfTheme,
} from "./view";
import { disposePdfEngine, initPdfEngine, LOG_TAG } from "./pdf-engine";
import {
  DEFAULT_ANNOTATION_FOLDER,
  normalizeAnnotationStorageFolder,
  type AnnotationPathOptions,
  type AnnotationStorageMode,
} from "./annotations";
import {
  DEFAULT_RECOVERY_FOLDER,
  PDF_BUNDLE_LIBRARY,
  PdfBundleManager,
  type PdfBundleBinding,
} from "./bundles";
import { pdfHotkeyAction, pickPdfHotkeyTarget } from "./hotkeys";

interface LumenSettings {
  registerAsDefaultPdfHandler: boolean;
  annotationStorageMode: AnnotationStorageMode;
  annotationStorageFolder: string;
  pdfTheme: PdfTheme;
}

const DEFAULT_SETTINGS: LumenSettings = {
  registerAsDefaultPdfHandler: false,
  annotationStorageMode: "folder",
  annotationStorageFolder: DEFAULT_ANNOTATION_FOLDER,
  pdfTheme: "light",
};

function coerceTheme(value: unknown): PdfTheme {
  if (value === "dark" || value === "night") return "dark";
  if (value === "sepia") return "sepia";
  return "light";
}

export default class LumenPdfPlugin extends Plugin {
  settings!: LumenSettings;
  bundleManager!: PdfBundleManager;
  private replacingCorePdfView = false;
  private lastPdfLeaf: WorkspaceLeaf | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.bundleManager = new PdfBundleManager(this.app);
    const status = initPdfEngine();
    if (!status.ok) new Notice("Lumen PDF: pdf.js worker check failed — see console.");

    this.registerView(VIEW_TYPE_PDF_ANNOTATOR, (leaf: WorkspaceLeaf) => {
      this.lastPdfLeaf = leaf;
      return new PdfAnnotatorView(
        leaf,
        () => this.annotationPathOptions(),
        this.bundleManager,
        () => this.settings.pdfTheme,
        (theme) => void this.setTheme(theme)
      );
    });
    this.addCommand({
      id: "open-current-pdf-in-annotator",
      name: "Open current PDF in Lumen annotator",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file instanceof TFile && file.extension === "pdf";
        if (available && !checking) void this.openInAnnotator(file, "tab");
        return available;
      },
    });

    this.addCommand({
      id: "import-legacy-annotations",
      name: "Import legacy annotations for this PDF",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(PdfAnnotatorView);
        if (!view?.file) return false;
        if (!checking) void view.importLegacyAnnotations();
        return true;
      },
    });

    this.addCommand({
      id: "export-current-pdf-annotations",
      name: "Export annotations for current PDF",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "pdf") return false;
        if (!checking) void this.exportAnnotations(file);
        return true;
      },
    });

    this.addCommand({
      id: "restore-backed-up-pdf",
      name: "Restore a PDF from annotation backup",
      callback: async () => {
        const bundles = await this.bundleManager.listBundles();
        if (!bundles.length) return void new Notice("Lumen PDF: no managed PDF backups found.");
        new PdfBackupRestoreModal(this, bundles).open();
      },
    });

    this.addCommand({
      id: "verify-pdf-annotation-backups",
      name: "Verify all PDF annotation backups",
      callback: () => void this.verifyBackups(),
    });

    this.registerReaderHotkeys();
    // Window capture runs before Obsidian's document-level find accelerator.
    // If any Lumen PDF is open, Cmd/Ctrl+F belongs to that reader even when
    // focus is in the file tree, annotation rail, another pane, or an input.
    this.registerDomEvent(window, "keydown", (evt) => this.onGlobalKeyDown(evt), true);

    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      if (file instanceof TFile && file.extension === "pdf") void this.openPdfClickInAnnotator(file);
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view instanceof PdfAnnotatorView) this.lastPdfLeaf = leaf;
      if (!this.settings.registerAsDefaultPdfHandler || !leaf || leaf.view.getViewType() !== "pdf") return;
      const file = (leaf.view as { file?: unknown }).file;
      if (file instanceof TFile && file.extension === "pdf") void this.openPdfClickInAnnotator(file);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || file.extension !== "pdf") return;
      void this.bundleManager.onPdfRenamed(file, oldPath);
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR)) {
        if (leaf.view instanceof PdfAnnotatorView) leaf.view.syncPdfPath(file);
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile && file.extension === "pdf") void this.bundleManager.onPdfDeleted(file.path);
    }));

    this.addSettingTab(new LumenSettingTab(this));
    console.log(`${LOG_TAG} Lumen PDF 0.6.1 loaded.`);
  }

  onunload(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR).forEach((leaf) => leaf.detach());
    disposePdfEngine();
  }

  async openInAnnotator(file: TFile, paneType: "tab" | "split" | false = "tab"): Promise<void> {
    const leaf = this.findLeaf(file) ?? this.app.workspace.getLeaf(paneType);
    await leaf.setViewState({ type: VIEW_TYPE_PDF_ANNOTATOR, state: { file: file.path }, active: true });
    this.lastPdfLeaf = leaf;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private registerReaderHotkeys(): void {
    this.addCommand({
      id: "toggle-pdf-search",
      name: "Toggle PDF search",
      checkCallback: (checking) => this.runOnPdfView(checking, true, (view) => view.togglePdfSearch()),
    });
    this.addCommand({
      id: "toggle-annotation-inspector",
      name: "Toggle annotation inspector",
      checkCallback: (checking) => this.runOnPdfView(checking, false, (view) => view.toggleAnnotationInspector()),
    });
    this.addCommand({
      id: "previous-pdf-page",
      name: "Previous PDF page",
      checkCallback: (checking) => this.runOnPdfView(checking, false, (view) => view.previousPdfPage()),
    });
    this.addCommand({
      id: "next-pdf-page",
      name: "Next PDF page",
      checkCallback: (checking) => this.runOnPdfView(checking, false, (view) => view.nextPdfPage()),
    });
    this.addCommand({
      id: "zoom-pdf-in",
      name: "Zoom PDF in",
      checkCallback: (checking) => this.runOnPdfView(checking, false, (view) => view.zoomPdfIn()),
    });
    this.addCommand({
      id: "zoom-pdf-out",
      name: "Zoom PDF out",
      checkCallback: (checking) => this.runOnPdfView(checking, false, (view) => view.zoomPdfOut()),
    });
    this.addCommand({
      id: "reset-pdf-zoom",
      name: "Reset PDF zoom",
      checkCallback: (checking) => this.runOnPdfView(checking, false, (view) => view.resetPdfZoom()),
    });
    this.addCommand({
      id: "toggle-page-note-placement",
      name: "Toggle page-note placement",
      checkCallback: (checking) => this.runOnPdfView(checking, false, (view) => view.togglePageNotePlacement()),
    });
  }

  private openPdfLeaves(): WorkspaceLeaf[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR)
      .filter((leaf) => leaf.view instanceof PdfAnnotatorView);
  }

  private pdfHotkeyTarget(allowBackground: boolean): { leaf: WorkspaceLeaf; view: PdfAnnotatorView } | null {
    const leaves = this.openPdfLeaves();
    const active = this.app.workspace.activeLeaf;
    const activePdf = active?.view instanceof PdfAnnotatorView ? active : null;
    const leaf = allowBackground
      ? pickPdfHotkeyTarget(activePdf, this.lastPdfLeaf, leaves)
      : pickPdfHotkeyTarget(activePdf, null, leaves.filter((candidate) => candidate === activePdf));
    if (!leaf || !(leaf.view instanceof PdfAnnotatorView)) return null;
    return { leaf, view: leaf.view };
  }

  private runOnPdfView(
    checking: boolean,
    allowBackground: boolean,
    action: (view: PdfAnnotatorView) => void
  ): boolean {
    const target = this.pdfHotkeyTarget(allowBackground);
    if (!target) return false;
    if (!checking) {
      this.lastPdfLeaf = target.leaf;
      if (this.app.workspace.activeLeaf !== target.leaf) {
        this.app.workspace.setActiveLeaf(target.leaf, { focus: true });
      }
      action(target.view);
    }
    return true;
  }

  private onGlobalKeyDown(event: KeyboardEvent): void {
    const action = pdfHotkeyAction(event);
    if (!action) return;
    const target = this.pdfHotkeyTarget(action === "toggle-search");
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.lastPdfLeaf = target.leaf;
    if (this.app.workspace.activeLeaf !== target.leaf) {
      this.app.workspace.setActiveLeaf(target.leaf, { focus: true });
    }
    if (action === "toggle-search") target.view.togglePdfSearch();
    else if (action === "toggle-inspector") target.view.toggleAnnotationInspector();
    else if (action === "zoom-in") target.view.zoomPdfIn();
    else if (action === "zoom-out") target.view.zoomPdfOut();
    else target.view.resetPdfZoom();
  }

  async setTheme(theme: PdfTheme): Promise<void> {
    this.settings.pdfTheme = theme;
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_ANNOTATOR)) {
      if (leaf.view instanceof PdfAnnotatorView) leaf.view.setPdfTheme(theme);
    }
  }

  annotationPathOptions(): AnnotationPathOptions {
    return {
      storageMode: this.settings.annotationStorageMode,
      storageFolder: this.settings.annotationStorageFolder,
    };
  }

  private findLeaf(file: TFile): WorkspaceLeaf | null {
    for (const type of [VIEW_TYPE_PDF_ANNOTATOR, "pdf"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const leafFile = (leaf.view as { file?: unknown }).file;
        if (leafFile instanceof TFile && leafFile.path === file.path) return leaf;
      }
    }
    return null;
  }

  private async openPdfClickInAnnotator(file: TFile): Promise<void> {
    if (!this.settings.registerAsDefaultPdfHandler || this.replacingCorePdfView) return;
    for (const delay of [0, 24, 80, 180, 360, 720, 1_200]) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
      const leaf = this.app.workspace.activeLeaf;
      if (!leaf) continue;
      const activePath = this.app.workspace.getActiveFile()?.path;
      const leafPath = ((leaf.view as { file?: unknown }).file as TFile | undefined)?.path;
      if (activePath !== file.path && leafPath !== file.path) continue;
      if (leaf.view.getViewType() === VIEW_TYPE_PDF_ANNOTATOR) return;
      this.replacingCorePdfView = true;
      try {
        await leaf.setViewState({ type: VIEW_TYPE_PDF_ANNOTATOR, state: { file: file.path }, active: true });
      } finally {
        this.replacingCorePdfView = false;
      }
      return;
    }
  }

  private async exportAnnotations(file: TFile): Promise<void> {
    try {
      await this.app.workspace.getActiveViewOfType(PdfAnnotatorView)?.checkpointAnnotations();
      const path = await this.bundleManager.exportAnnotations(file, `${this.settings.annotationStorageFolder}/Exports`);
      new Notice(`Lumen PDF: exported ${path}`);
    } catch (error: any) {
      console.error(`${LOG_TAG} annotation export failed`, error);
      new Notice(`Lumen PDF: export failed — ${error?.message ?? error}`);
    }
  }

  private async verifyBackups(): Promise<void> {
    const bundles = await this.bundleManager.listBundles();
    if (!bundles.length) return void new Notice("Lumen PDF: no managed PDF backups found.");
    let failed = 0;
    for (const bundle of bundles) if (!(await this.bundleManager.verifyBundle(bundle)).ok) failed++;
    new Notice(failed ? `Lumen PDF: ${failed} backup checks failed — see console.` : `Lumen PDF: verified ${bundles.length} backups.`);
  }

  private async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      annotationStorageMode: saved.annotationStorageMode === "beside-pdf" ? "beside-pdf" : "folder",
      annotationStorageFolder: normalizeAnnotationStorageFolder(saved.annotationStorageFolder),
      pdfTheme: coerceTheme(saved.pdfTheme),
    };
  }
}

class LumenSettingTab extends PluginSettingTab {
  constructor(private plugin: LumenPdfPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Lumen PDF" });
    new Setting(containerEl)
      .setName("Make Lumen the default PDF viewer")
      .setDesc("Open ordinary PDF clicks in the fast annotator view.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.registerAsDefaultPdfHandler).onChange(async (value) => {
        this.plugin.settings.registerAsDefaultPdfHandler = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(containerEl)
      .setName("PDF theme")
      .setDesc("Choose the initial paper appearance. It can also be changed from the reader toolbar.")
      .addDropdown((dropdown) => dropdown
        .addOption("light", "Light")
        .addOption("sepia", "Sepia")
        .addOption("dark", "Dark")
        .setValue(this.plugin.settings.pdfTheme)
        .onChange((value) => this.plugin.setTheme(coerceTheme(value))));
    new Setting(containerEl)
      .setName("Legacy annotation folder")
      .setDesc(`Existing path-based sidecars are imported from this folder. Managed data remains in ${PDF_BUNDLE_LIBRARY}.`)
      .addText((text) => text.setValue(this.plugin.settings.annotationStorageFolder).onChange(async (value) => {
        this.plugin.settings.annotationStorageFolder = normalizeAnnotationStorageFolder(value);
        await this.plugin.saveData(this.plugin.settings);
      }));
  }
}

class PdfBackupRestoreModal extends FuzzySuggestModal<PdfBundleBinding> {
  constructor(private plugin: LumenPdfPlugin, private bundles: PdfBundleBinding[]) {
    super(plugin.app);
    this.setPlaceholder("Choose a backed-up PDF to restore");
  }
  getItems(): PdfBundleBinding[] { return this.bundles; }
  getItemText(binding: PdfBundleBinding): string {
    return `${binding.manifest.originalName} — ${binding.manifest.currentPath ?? "working copy deleted"}`;
  }
  onChooseItem(binding: PdfBundleBinding): void { void this.restore(binding); }
  private async restore(binding: PdfBundleBinding): Promise<void> {
    try {
      const file = await this.plugin.bundleManager.restoreBundle(binding, DEFAULT_RECOVERY_FOLDER);
      new Notice(`Lumen PDF: restored ${file.path}`);
      await this.plugin.openInAnnotator(file, "tab");
    } catch (error: any) {
      new Notice(`Lumen PDF: restore failed — ${error?.message ?? error}`);
    }
  }
}
