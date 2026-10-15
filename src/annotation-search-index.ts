import { App, TFile, TFolder } from "obsidian";
import { annotationUri } from "./links";
import type { AnnotationIndex, PdfAnnotation } from "./model";
import { AnnotationRepository, listAnnotationBundles } from "./storage";

export const ANNOTATION_SEARCH_FOLDER = "Lumen PDF annotation index";
const MARKER_PREFIX = "<!-- lumen-pdf-annotator-index:v1:";
const ANNOTATIONS_PER_NOTE = 200;
const UPDATE_DELAY_MS = 1_500;

export interface AnnotationSearchSource {
  hash: string;
  folder: string;
  pdfPath: string;
  index: AnnotationIndex;
  flush: () => Promise<void>;
}

function pause(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

function marker(hash: string): string {
  return MARKER_PREFIX + hash + " -->";
}

function indexedHash(content: string): string | null {
  const match = /^<!-- lumen-pdf-annotator-index:v1:([a-f0-9]{64}) -->/.exec(content);
  return match?.[1] ?? null;
}

function escapeMarkdown(value: string): string {
  // Keep underscores literal so an exact search for a quoted identifier still matches.
  return value.replace(/[\\\x60*{}[\]<>|#]/g, "\\$&");
}

function fileStem(pdfPath: string): string {
  return (pdfPath.split("/").at(-1) ?? "PDF")
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, "-")
    .trim()
    .slice(0, 70) || "PDF";
}

function searchNotePath(hash: string, pdfPath: string, part: number): string {
  return ANNOTATION_SEARCH_FOLDER + "/Lumen-" + fileStem(pdfPath) + "--" + hash.slice(0, 16)
    + "--" + String(part).padStart(4, "0") + ".md";
}

function pageLabel(members: PdfAnnotation[]): string {
  const pages = Array.from(new Set(members.map(item => item.page))).sort((a, b) => a - b);
  return pages.length === 1 ? "Page " + pages[0] : "Pages " + pages.join(", ");
}

function renderSearchNote(
  hash: string,
  pdfPath: string,
  vaultName: string,
  anchors: PdfAnnotation[],
  index: AnnotationIndex,
  part: number,
): string {
  const lines = [
    marker(hash),
    "<!-- Generated search copy. Edit annotations in the PDF; Lumen replaces this file. -->",
    "# Annotations — " + escapeMarkdown(pdfPath.split("/").at(-1) ?? pdfPath),
    "",
    "Source PDF: " + escapeMarkdown(pdfPath),
    "",
  ];
  for (const anchor of anchors) {
    const members = index.inGroup(anchor.id)
      .sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0));
    if (!members.length) continue;
    const target = anchor.groupId || anchor.id;
    const link = "[Open annotation in Lumen](" + annotationUri(vaultName, pdfPath, target) + ")";
    let hasLink = false;
    lines.push("## " + pageLabel(members) + " · " + (anchor.kind === "page-note" ? "Page note" : "Highlight"), "");
    for (const member of members) {
      if (member.kind === "page-note" || !member.quote.trim()) continue;
      if (members.length > 1) lines.push("Page " + member.page, "");
      lines.push(link, "");
      hasLink = true;
      for (const line of member.quote.trim().split(/\r?\n/)) lines.push("> " + escapeMarkdown(line));
      lines.push("");
    }
    const note = members.find(item => item.id === target && item.note.trim())?.note
      ?? members.find(item => item.note.trim())?.note;
    if (note) {
      lines.push("Note:", "");
      for (const line of note.trim().split(/\r?\n/)) lines.push(escapeMarkdown(line));
      lines.push("", link, "");
      hasLink = true;
    }
    const tags = members.find(item => item.tags.length)?.tags ?? [];
    if (tags.length) lines.push("Tags: " + tags.map(escapeMarkdown).join(", "), "");
    if (!hasLink) lines.push(link, "");
  }
  lines.push("<!-- Part " + part + " -->", "");
  return lines.join("\n");
}

/** A disposable, searchable Markdown copy. The annotation repository remains authoritative. */
export class AnnotationSearchIndex {
  private enabled: boolean;
  private generation = 0;
  private pending = new Map<string, AnnotationSearchSource>();
  private timer: number | null = null;
  private startupTimer: number | null = null;
  private work: Promise<void> = Promise.resolve();
  private reportedError = false;

  constructor(
    private readonly app: App,
    private readonly openSources: () => AnnotationSearchSource[],
    enabled: boolean,
    private readonly onError?: () => void,
  ) {
    this.enabled = enabled;
  }

  private get vault() {
    return this.app.vault;
  }

  start(): void {
    if (!this.enabled) return;
    const generation = this.generation;
    this.startupTimer = window.setTimeout(() => {
      this.startupTimer = null;
      this.enqueue(() => this.rebuild(generation));
    }, 1_500);
  }

  setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return this.work;
    this.enabled = enabled;
    const generation = ++this.generation;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
    this.timer = this.startupTimer = null;
    this.pending.clear();
    if (enabled) this.reportedError = false;
    if (enabled) this.enqueue(() => this.rebuild(generation));
    else this.enqueue(() => this.removeAll(generation));
    return this.work;
  }

  schedule(source: AnnotationSearchSource): void {
    if (!this.enabled) return;
    this.pending.set(source.hash, source);
    if (this.timer !== null) window.clearTimeout(this.timer);
    const generation = this.generation;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const sources = Array.from(this.pending.values());
      this.pending.clear();
      this.enqueue(async () => {
        for (const item of sources) {
          if (!this.active(generation)) return;
          await this.syncSource(item, generation);
        }
      });
    }, UPDATE_DELAY_MS);
  }

  dispose(): void {
    this.enabled = false;
    ++this.generation;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.startupTimer !== null) window.clearTimeout(this.startupTimer);
    this.timer = this.startupTimer = null;
    this.pending.clear();
  }

  private active(generation: number): boolean {
    return this.enabled && this.generation === generation;
  }

  private enqueue(job: () => Promise<void>): void {
    this.work = this.work.then(job).catch(error => this.reportError(error));
  }

  private reportError(error: unknown): void {
    console.error("Lumen could not update annotation search copies", error);
    if (this.reportedError) return;
    this.reportedError = true;
    this.onError?.();
  }

  private async rebuild(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    const open = new Map(this.openSources().map(source => [source.hash, source]));
    const bundles = await listAnnotationBundles(this.vault);
    const seen = new Set<string>();
    for (const bundle of bundles) {
      if (!this.active(generation)) return;
      seen.add(bundle.hash);
      try {
        const source = open.get(bundle.hash) ?? {
          hash: bundle.hash,
          folder: bundle.folder,
          pdfPath: bundle.manifest.workingPath,
          index: await new AnnotationRepository(this.vault, bundle.folder, bundle.hash, bundle.manifest.workingPath).load(),
          flush: async () => undefined,
        };
        await this.syncSource(source, generation);
      } catch (error) {
        this.reportError(error);
      }
      await pause();
    }
    for (const source of open.values()) {
      if (!seen.has(source.hash) && this.active(generation)) await this.syncSource(source, generation);
      seen.add(source.hash);
    }
    if (this.active(generation)) await this.removeOrphans(seen, generation);
  }

  private async folder(create: boolean): Promise<TFolder | null> {
    const existing = this.vault.getAbstractFileByPath(ANNOTATION_SEARCH_FOLDER);
    if (existing instanceof TFolder) return existing;
    if (existing) throw new Error("The annotation index folder path is occupied by a file.");
    if (!create) return null;
    return this.vault.createFolder(ANNOTATION_SEARCH_FOLDER);
  }

  private async syncSource(source: AnnotationSearchSource, generation: number): Promise<void> {
    if (!this.active(generation) || !/^[a-f0-9]{64}$/.test(source.hash)) return;
    const views = this.openSources().filter(item => item.hash === source.hash);
    let index = source.index;
    if (views.length > 1) {
      for (const view of views) await view.flush();
      index = await new AnnotationRepository(this.vault, source.folder, source.hash, source.pdfPath).load();
    } else {
      await source.flush();
    }
    if (!this.active(generation)) return;
    const anchors = index.logicalAll();
    const expected = new Set<string>();
    if (anchors.length) await this.folder(true);
    for (let offset = 0; offset < anchors.length; offset += ANNOTATIONS_PER_NOTE) {
      if (!this.active(generation)) return;
      const part = Math.floor(offset / ANNOTATIONS_PER_NOTE) + 1;
      const path = searchNotePath(source.hash, source.pdfPath, part);
      const content = renderSearchNote(source.hash, source.pdfPath, this.vault.getName(),
        anchors.slice(offset, offset + ANNOTATIONS_PER_NOTE), index, part);
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing && !(existing instanceof TFile)) throw new Error("The annotation index note path is occupied by a folder: " + path);
      if (existing) {
        const previous = await this.vault.read(existing);
        if (indexedHash(previous) !== source.hash) throw new Error("Refusing to overwrite a non-Lumen note: " + path);
        if (previous !== content) await this.vault.modify(existing, content);
      } else {
        await this.vault.create(path, content);
      }
      expected.add(path);
      await pause();
    }
    if (this.active(generation)) await this.removeStale(source.hash, expected, generation);
  }

  private async removeStale(hash: string, expected: Set<string>, generation: number): Promise<void> {
    const folder = await this.folder(false);
    if (!folder) return;
    for (const item of [...folder.children]) {
      if (!this.active(generation)) return;
      if (!(item instanceof TFile) || expected.has(item.path) || !item.name.includes("--" + hash.slice(0, 16) + "--")) continue;
      if (indexedHash(await this.vault.read(item)) === hash) await this.app.fileManager.trashFile(item);
      await pause();
    }
  }

  private async removeOrphans(seen: Set<string>, generation: number): Promise<void> {
    const folder = await this.folder(false);
    if (!folder) return;
    for (const item of [...folder.children]) {
      if (!this.active(generation)) return;
      if (!(item instanceof TFile)) continue;
      const hash = indexedHash(await this.vault.read(item));
      if (hash && !seen.has(hash)) await this.app.fileManager.trashFile(item);
      await pause();
    }
  }

  private async removeAll(generation: number): Promise<void> {
    const folder = await this.folder(false);
    if (!folder) return;
    let removed = false;
    for (const item of [...folder.children]) {
      if (this.enabled || generation !== this.generation) return;
      if (item instanceof TFile && indexedHash(await this.vault.read(item))) {
        await this.app.fileManager.trashFile(item);
        removed = true;
      }
      await pause();
    }
    if (!this.enabled && generation === this.generation && removed && folder.children.length === 0) {
      await this.app.fileManager.trashFile(folder);
    }
  }
}
