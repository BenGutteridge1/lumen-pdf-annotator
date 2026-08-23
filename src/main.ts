import { FuzzySuggestModal, normalizePath, Notice, ObsidianProtocolData, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { LUMEN_PROTOCOL_ACTION } from "./links";
import { disposePdfRuntime } from "./pdf-runtime";
import { BundleInfo, listBundles, restoreBundle, verifyBundle } from "./storage";
import { LumenPdfView, LUMEN_VIEW_TYPE, PdfTheme } from "./view";

interface LumenSettings {
  defaultViewer: boolean;
  pdfTheme: PdfTheme;
  legacyAnnotationFolder: string;
}

const DEFAULT_SETTINGS: LumenSettings = { defaultViewer: true, pdfTheme: "light", legacyAnnotationFolder: "PDF annotations" };

interface ViewRegistryWithExtensions {
  typeByExtension: Record<string, string>;
}

export default class LumenPdfPlugin extends Plugin {
  settings: LumenSettings = DEFAULT_SETTINGS;
  private mostRecentPdfPath: string | null = null;
  private settingsWrite: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!["light", "sepia", "dark"].includes(this.settings.pdfTheme)) this.settings.pdfTheme = DEFAULT_SETTINGS.pdfTheme;
    this.registerView(LUMEN_VIEW_TYPE, leaf => new LumenPdfView(
      leaf,
      this.settings.pdfTheme,
      theme => void this.setPdfTheme(theme).catch(error => {
        console.error("Lumen could not save the PDF theme", error);
        new Notice("Lumen could not save the PDF theme. Your current document will keep using it until reload.");
      }),
      this.settings.legacyAnnotationFolder,
    ));
    if (this.settings.defaultViewer) this.installAsDefaultPdfViewer();
    this.registerEvent(this.app.workspace.on("file-open", file => {
      if (file?.extension.toLowerCase() === "pdf") this.mostRecentPdfPath = file.path;
    }));
    this.registerDomEvent(window, "keydown", event => this.routeReaderHotkey(event), true);
    this.registerObsidianProtocolHandler(LUMEN_PROTOCOL_ACTION, params => void this.openAnnotationLink(params).catch(error => {
      console.error("Lumen could not open an annotation link", error);
      new Notice("Lumen could not open this annotation link.");
    }));

    this.addCommand({
      id: "open-current-pdf-in-lumen",
      name: "Open current PDF in Lumen annotator",
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") return false;
        if (!checking) void this.openFile(file);
        return true;
      },
    });
    this.addReaderCommand("toggle-pdf-search", "Toggle PDF search", view => view.toggleSearch());
    this.addReaderCommand("toggle-annotation-inspector", "Toggle annotation inspector", view => view.toggleInspector());
    this.addReaderCommand("previous-pdf-page", "Previous PDF page", view => view.previousPage());
    this.addReaderCommand("next-pdf-page", "Next PDF page", view => view.nextPage());
    this.addReaderCommand("zoom-pdf-in", "Zoom PDF in", view => view.zoomIn());
    this.addReaderCommand("zoom-pdf-out", "Zoom PDF out", view => view.zoomOut());
    this.addReaderCommand("reset-pdf-zoom", "Reset PDF zoom", view => view.resetZoom());
    this.addReaderCommand("place-page-note", "Place a page note", view => view.togglePageNotePlacement());
    this.addReaderCommand("checkpoint-annotations", "Save an annotation checkpoint", async view => {
      await view.checkpointAnnotations();
      new Notice("Lumen annotation checkpoint saved.");
    });
    this.addReaderCommand("export-annotations", "Export annotations for this PDF", async view => {
      const path = await view.exportAnnotations();
      if (path) new Notice(`Annotations exported to ${path}`);
    });
    this.addReaderCommand("import-legacy-annotations", "Import legacy annotations for this PDF", view => view.importLegacyAnnotations(true));
    this.addCommand({ id: "verify-pdf-backups", name: "Verify all PDF backup checksums", callback: () => void this.verifyAllBackups() });
    this.addCommand({ id: "restore-backed-up-pdf", name: "Restore a backed-up PDF", callback: () => void this.chooseBackupToRestore() });
    this.addSettingTab(new LumenSettingTab(this));
  }

  onunload(): void {
    disposePdfRuntime();
  }

  private installAsDefaultPdfViewer(): void {
    // Obsidian reserves the PDF extension for its built-in view, so
    // registerExtensions() rejects it. Preserve and restore the exact prior
    // mapping instead of deleting or permanently mutating the core handler.
    const registry = (this.app as unknown as { viewRegistry: ViewRegistryWithExtensions }).viewRegistry;
    const previous = registry.typeByExtension.pdf;
    registry.typeByExtension.pdf = LUMEN_VIEW_TYPE;
    this.register(() => {
      if (registry.typeByExtension.pdf === LUMEN_VIEW_TYPE) registry.typeByExtension.pdf = previous;
    });
  }

  private addReaderCommand(
    id: string,
    name: string,
    action: (view: LumenPdfView) => void | Promise<unknown>,
  ): void {
    this.addCommand({
      id,
      name,
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(LumenPdfView);
        if (!view) return false;
        if (!checking) void Promise.resolve(action(view)).catch(error => {
          console.error("Lumen command failed", error);
          new Notice(`Lumen could not complete the command: ${error instanceof Error ? error.message : String(error)}`);
        });
        return true;
      },
    });
  }

  private async openFile(file: TFile, leaf = this.app.workspace.getLeaf(false) as WorkspaceLeaf): Promise<LumenPdfView | null> {
    this.mostRecentPdfPath = file.path;
    await leaf.setViewState({ type: LUMEN_VIEW_TYPE, active: true, state: { file: file.path } });
    this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof LumenPdfView ? leaf.view : null;
  }

  private async openAnnotationLink(params: ObsidianProtocolData): Promise<void> {
    if (params.vault && params.vault !== this.app.vault.getName()) {
      new Notice(`This Lumen link belongs to the “${params.vault}” vault.`);
      return;
    }
    if (!params.file || !params.annotation) {
      new Notice("This Lumen highlight link is incomplete.");
      return;
    }
    const exactPath = normalizePath(params.file);
    const legacyPath = normalizePath(params.file.replace(/\+/g, " "));
    const target = this.app.vault.getAbstractFileByPath(exactPath)
      ?? (legacyPath !== exactPath ? this.app.vault.getAbstractFileByPath(legacyPath) : null);
    if (!(target instanceof TFile) || target.extension.toLowerCase() !== "pdf") {
      new Notice("The PDF for this Lumen highlight link could not be found.");
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab") as WorkspaceLeaf;
    const view = await this.openFile(target, leaf);
    if (!view || !(await view.revealAnnotation(params.annotation))) {
      new Notice("The linked highlight could not be found in this PDF.");
    }
  }

  async setPdfTheme(theme: PdfTheme): Promise<void> {
    this.settings.pdfTheme = theme;
    for (const leaf of this.app.workspace.getLeavesOfType(LUMEN_VIEW_TYPE)) {
      if (leaf.view instanceof LumenPdfView) leaf.view.setTheme(theme);
    }
    await this.saveSettings();
  }

  saveSettings(): Promise<void> {
    const snapshot = { ...this.settings };
    const write = this.settingsWrite.catch(() => undefined).then(() => this.saveData(snapshot));
    this.settingsWrite = write;
    return write;
  }

  private routeReaderHotkey(event: KeyboardEvent): void {
    const primary = navigator.platform.includes("Mac") ? event.metaKey : event.ctrlKey;
    if (!primary || event.altKey) return;
    const key = event.key.toLowerCase();
    let view = this.app.workspace.getActiveViewOfType(LumenPdfView);
    if (key === "f" && !event.shiftKey && !view) {
      const recentLeaf = this.app.workspace.getLeavesOfType(LUMEN_VIEW_TYPE).at(-1);
      if (recentLeaf?.view instanceof LumenPdfView) {
        this.app.workspace.revealLeaf(recentLeaf);
        view = recentLeaf.view;
      } else {
        const file = this.mostRecentPdfPath ? this.app.vault.getAbstractFileByPath(this.mostRecentPdfPath) : this.app.workspace.getActiveFile();
        if (file instanceof TFile && file.extension.toLowerCase() === "pdf") {
          event.preventDefault();
          event.stopImmediatePropagation();
          void this.openFile(file).then(() => this.app.workspace.getActiveViewOfType(LumenPdfView)?.toggleSearch());
        }
        return;
      }
    }
    if (!view) return;
    if (key === "f" && !event.shiftKey) {
      event.preventDefault(); event.stopImmediatePropagation(); view.toggleSearch();
    } else if (key === "a" && event.shiftKey) {
      event.preventDefault(); event.stopImmediatePropagation(); view.toggleInspector();
    } else if (key === "=" || key === "+") {
      event.preventDefault(); view.zoomIn();
    } else if (key === "-") {
      event.preventDefault(); view.zoomOut();
    } else if (key === "0") {
      event.preventDefault(); view.resetZoom();
    }
  }

  private async verifyAllBackups(): Promise<void> {
    const bundles = await listBundles(this.app.vault);
    if (!bundles.length) {
      new Notice("No Lumen PDF backups found.");
      return;
    }
    let valid = 0;
    const failures: string[] = [];
    for (const bundle of bundles) {
      const result = await verifyBundle(this.app.vault, bundle);
      if (result.ok) valid++;
      else failures.push(`${bundle.manifest.originalName}: ${result.reason ?? "verification failed"}`);
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    if (failures.length) {
      console.error("Lumen backup verification failures", failures);
      new Notice(`${valid}/${bundles.length} PDF backups verified. ${failures.length} failed; details are in the developer console.`, 8000);
    } else {
      new Notice(`All ${valid} PDF backup${valid === 1 ? "" : "s"} verified.`);
    }
  }

  private async chooseBackupToRestore(): Promise<void> {
    const bundles = await listBundles(this.app.vault);
    if (!bundles.length) {
      new Notice("No Lumen PDF backups found.");
      return;
    }
    new BackupRestoreModal(this, bundles).open();
  }
}

class BackupRestoreModal extends FuzzySuggestModal<BundleInfo> {
  constructor(private readonly plugin: LumenPdfPlugin, private readonly bundles: BundleInfo[]) {
    super(plugin.app);
    this.setPlaceholder("Choose a PDF backup to restore");
  }

  getItems(): BundleInfo[] { return this.bundles; }
  getItemText(item: BundleInfo): string { return `${item.manifest.originalName} — ${item.manifest.workingPath}`; }
  async onChooseItem(item: BundleInfo): Promise<void> {
    try {
      const file = await restoreBundle(this.plugin.app.vault, item);
      new Notice(`Restored ${file.path}`);
      await this.plugin.app.workspace.getLeaf(true).openFile(file);
    } catch (error) {
      console.error("Lumen restore failed", error);
      new Notice(`Restore failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
    }
  }
}

class LumenSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: LumenPdfPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Make Lumen the default PDF viewer")
      .setDesc("Open PDFs in Lumen after the next Obsidian restart.")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.defaultViewer).onChange(async value => {
        this.plugin.settings.defaultViewer = value;
        await this.plugin.saveSettings();
        new Notice("Restart Obsidian to apply the PDF viewer change.");
      }));
    new Setting(this.containerEl)
      .setName("PDF theme")
      .setDesc("Use this document theme for every Lumen reader.")
      .addDropdown(dropdown => dropdown
        .addOptions({ light: "Light", sepia: "Sepia", dark: "Dark" })
        .setValue(this.plugin.settings.pdfTheme)
        .onChange(async value => {
          await this.plugin.setPdfTheme(value as PdfTheme);
        }));
    new Setting(this.containerEl)
      .setName("Legacy annotation folder")
      .setDesc("Look here for older Markdown annotation notes that target the open PDF.")
      .addText(text => text
        .setPlaceholder("PDF annotations")
        .setValue(this.plugin.settings.legacyAnnotationFolder)
        .onChange(async value => {
          this.plugin.settings.legacyAnnotationFolder = value.trim().replace(/^\/+|\/+$/g, "") || "PDF annotations";
          await this.plugin.saveSettings();
        }));
  }
}
