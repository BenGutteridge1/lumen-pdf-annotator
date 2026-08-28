import { normalizePath, TFile, Vault } from "obsidian";
import { AnnotationIndex, AnnotationMutation, MARK_COLORS, MarkStyle, PdfAnnotation } from "./model";

const ROOT = ".lumen-pdf/bundles/sha256";
const LEGACY_ROOT = ".pdf-annotator/bundles/sha256";
const FILE_INDEX_ROOT = ".lumen-pdf/file-index";

export interface BundleManifest {
  version: number;
  sha256: string;
  workingPath: string;
  originalName: string;
  updatedAt: string;
}

export interface BundleInfo {
  hash: string;
  folder: string;
  backupPath: string;
  manifest: BundleManifest;
}

export interface BackupVerification {
  bundle: BundleInfo;
  ok: boolean;
  reason?: string;
}

export interface LegacyAnnotationRecord {
  id?: string;
  type?: "highlight" | "tag";
  page?: number;
  color?: string;
  style?: string;
  text?: string;
  note?: string;
  noteContentCJK?: string;
  tags?: string[];
  rects?: Array<{ x1?: number; y1?: number; x2?: number; y2?: number }>;
  tagX?: number;
  tagY?: number;
  created?: string;
}

export interface DocumentBundle {
  hash: string;
  folder: string;
  repository: AnnotationRepository;
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function stablePathKey(path: string): string {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index++) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(36)}-${path.length.toString(36)}`;
}

async function documentHash(vault: Vault, file: TFile, bytes: ArrayBuffer): Promise<string> {
  await ensureFolder(vault, FILE_INDEX_ROOT);
  const cachePath = `${FILE_INDEX_ROOT}/${stablePathKey(file.path)}.json`;
  if (await vault.adapter.exists(cachePath)) {
    try {
      const cached = JSON.parse(await vault.adapter.read(cachePath)) as {
        path?: unknown;
        mtime?: unknown;
        size?: unknown;
        hash?: unknown;
      };
      if (cached.path === file.path
        && cached.mtime === file.stat.mtime
        && cached.size === file.stat.size
        && typeof cached.hash === "string"
        && /^[a-f0-9]{64}$/.test(cached.hash)) {
        return cached.hash;
      }
    } catch { /* recompute invalid cache entries */ }
  }
  const hash = await sha256(bytes);
  await vault.adapter.write(cachePath, JSON.stringify({
    path: file.path,
    mtime: file.stat.mtime,
    size: file.stat.size,
    hash,
  }));
  return hash;
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  let current = "";
  for (const part of normalizePath(path).split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!(await vault.adapter.exists(current))) await vault.adapter.mkdir(current);
  }
}

async function snapshotMarkdown(annotations: PdfAnnotation[], pdfPath: string, hash: string): Promise<string> {
  const groups = new Map<string, PdfAnnotation[]>();
  for (const annotation of annotations) {
    const groupId = annotation.groupId || annotation.id;
    let members = groups.get(groupId);
    if (!members) groups.set(groupId, members = []);
    members.push(annotation);
  }
  const sorted = Array.from(groups.entries()).map(([groupId, members]) => ({
    annotation: members.find(item => item.id === groupId) ?? members[0],
    pages: Array.from(new Set(members.map(item => item.page))).sort((a, b) => a - b),
  })).sort((a, b) => a.pages[0] - b.pages[0] || a.annotation.createdAt - b.annotation.createdAt);
  const chronological = [...annotations].sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const lines = [
    "---",
    "lumen-pdf-annotations: true",
    `pdf: ${JSON.stringify(pdfPath)}`,
    `sha256: ${hash}`,
    `updated: ${new Date().toISOString()}`,
    "---",
    "",
    "# PDF annotations",
    "",
  ];
  for (let index = 0; index < sorted.length; index++) {
    const { annotation: item, pages } = sorted[index];
    const pageLabel = pages.length === 1 ? `Page ${pages[0]}` : `Pages ${pages.join(", ")}`;
    lines.push(`## ${pageLabel}`, "", `> ${item.quote.replaceAll("\n", " ")}`, "");
    if (item.note) lines.push(item.note, "");
    if (item.tags.length) lines.push(`Tags: ${item.tags.map(tag => `#${tag}`).join(" ")}`, "");
    if (index > 0 && index % 750 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  }
  lines.push("```json lumen-pdf-data", "[");
  for (let index = 0; index < chronological.length; index++) {
    lines.push(`${JSON.stringify(chronological[index])}${index + 1 < chronological.length ? "," : ""}`);
    if (index > 0 && index % 750 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  }
  lines.push("]", "```", "");
  return lines.join("\n");
}

function yieldToHost(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

function schedulePdfBackup(vault: Vault, sourcePath: string, backupPath: string): void {
  // A full PDF copy is useful for recovery, but it must never sit on the
  // document-open critical path. DataAdapter.copy performs the filesystem work
  // without constructing another large ArrayBuffer in the renderer process.
  window.setTimeout(() => {
    void (async () => {
      if (await vault.adapter.exists(backupPath)) return;
      const partialPath = `${backupPath}.partial`;
      if (await vault.adapter.exists(partialPath)) await vault.adapter.remove(partialPath);
      await vault.adapter.copy(sourcePath, partialPath);
      if (await vault.adapter.exists(backupPath)) {
        await vault.adapter.remove(partialPath);
        return;
      }
      await vault.adapter.rename(partialPath, backupPath);
    })().catch(error => console.error("Lumen could not create a background PDF backup", error));
  }, 1_500);
}

async function readSnapshot(markdown: string): Promise<PdfAnnotation[]> {
  const match = markdown.match(/```json lumen-pdf-data\n([\s\S]*?)\n```/);
  if (!match) return [];
  try {
    const value: unknown = JSON.parse(match[1]);
    if (!Array.isArray(value)) return [];
    const annotations: PdfAnnotation[] = [];
    for (let index = 0; index < value.length; index++) {
      const annotation = normalizeAnnotation(value[index]);
      if (annotation) annotations.push(annotation);
      if (index > 0 && index % 1_000 === 0) await yieldToHost();
    }
    return annotations;
  } catch {
    return [];
  }
}

async function readJsonSnapshot(json: string): Promise<PdfAnnotation[] | null> {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return null;
    const annotations: PdfAnnotation[] = [];
    for (let index = 0; index < value.length; index++) {
      const annotation = normalizeAnnotation(value[index]);
      if (annotation) annotations.push(annotation);
      if (index > 0 && index % 1_000 === 0) await yieldToHost();
    }
    return annotations;
  } catch {
    return null;
  }
}

async function compactSnapshot(annotations: PdfAnnotation[]): Promise<string> {
  const chunks = ["["];
  for (let index = 0; index < annotations.length; index++) {
    chunks.push(`${JSON.stringify(annotations[index])}${index + 1 < annotations.length ? "," : ""}`);
    if (index > 0 && index % 1_000 === 0) await yieldToHost();
  }
  chunks.push("]");
  return chunks.join("");
}

function isMarkStyle(value: unknown): value is MarkStyle {
  return value === "highlight" || value === "underline" || value === "dashed" || value === "dotted"
    || value === "strike" || value === "box" || value === "comment";
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeAnnotation(value: unknown): PdfAnnotation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<PdfAnnotation>;
  if (typeof item.id !== "string" || !item.id || !Array.isArray(item.rects)) return null;
  const page = Math.max(1, Math.trunc(finite(item.page, 1)));
  const rects = item.rects.flatMap(rect => {
    if (!rect || typeof rect !== "object") return [];
    const x = finite(rect.x, Number.NaN);
    const y = finite(rect.y, Number.NaN);
    const width = finite(rect.width, Number.NaN);
    const height = finite(rect.height, Number.NaN);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    const left = Math.max(0, Math.min(1, x));
    const top = Math.max(0, Math.min(1, y));
    const right = Math.max(0, Math.min(1, x + width));
    const bottom = Math.max(0, Math.min(1, y + height));
    if (right <= left || bottom <= top) return [];
    return [{
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    }];
  });
  if (!rects.length) return null;
  const createdAt = finite(item.createdAt, Date.now());
  const style = isMarkStyle(item.style) ? item.style : "highlight";
  return {
    id: item.id,
    groupId: typeof item.groupId === "string" && item.groupId.trim() ? item.groupId : undefined,
    kind: item.kind === "page-note" ? "page-note" : "text",
    page,
    rects,
    quote: typeof item.quote === "string" ? item.quote : item.kind === "page-note" ? "Page note" : "",
    note: typeof item.note === "string" ? item.note : "",
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [],
    color: typeof item.color === "string" && item.color.trim() ? item.color : MARK_COLORS[0],
    style,
    createdAt,
    updatedAt: finite(item.updatedAt, createdAt),
  };
}

function normalizeMutation(value: unknown): AnnotationMutation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as { op?: unknown; annotation?: unknown; id?: unknown; at?: unknown };
  if (item.op === "put") {
    const annotation = normalizeAnnotation(item.annotation);
    return annotation ? { op: "put", annotation } : null;
  }
  if (item.op === "remove" && typeof item.id === "string") {
    return { op: "remove", id: item.id, at: finite(item.at, Date.now()) };
  }
  return null;
}

export class AnnotationRepository {
  private readonly snapshotPath: string;
  private readonly previousPath: string;
  private readonly compactSnapshotPath: string;
  private readonly compactPreviousPath: string;
  private readonly journalPath: string;
  private readonly queued = new Map<string, AnnotationMutation>();
  private flushTimer: number | null = null;
  private flushing: Promise<void> | null = null;
  private dirty = false;

  constructor(
    private readonly vault: Vault,
    folder: string,
    private readonly hash: string,
    private readonly pdfPath: string,
  ) {
    this.snapshotPath = `${folder}/annotations.md`;
    this.previousPath = `${folder}/annotations.previous.md`;
    this.compactSnapshotPath = `${folder}/annotations.snapshot.json`;
    this.compactPreviousPath = `${folder}/annotations.snapshot.previous.json`;
    this.journalPath = `${folder}/annotations.journal.jsonl`;
  }

  async load(): Promise<AnnotationIndex> {
    const index = new AnnotationIndex();
    let snapshot: PdfAnnotation[] = [];
    let preserveLegacyOrder = false;
    let loadedSnapshot = false;
    if (await this.vault.adapter.exists(this.compactSnapshotPath)) {
      const primary = await readJsonSnapshot(await this.vault.adapter.read(this.compactSnapshotPath));
      if (primary) {
        snapshot = primary;
        loadedSnapshot = true;
      } else {
        this.dirty = true;
      }
    }
    if (!loadedSnapshot && await this.vault.adapter.exists(this.compactPreviousPath)) {
      const previous = await readJsonSnapshot(await this.vault.adapter.read(this.compactPreviousPath));
      if (previous) {
        snapshot = previous;
        loadedSnapshot = true;
      }
      this.dirty = true;
    }
    if (!loadedSnapshot && await this.vault.adapter.exists(this.snapshotPath)) {
      snapshot = await readSnapshot(await this.vault.adapter.read(this.snapshotPath));
      preserveLegacyOrder = true;
      loadedSnapshot = true;
      this.dirty = true;
    } else if (!loadedSnapshot && await this.vault.adapter.exists(this.previousPath)) {
      snapshot = await readSnapshot(await this.vault.adapter.read(this.previousPath));
      preserveLegacyOrder = true;
      loadedSnapshot = true;
      this.dirty = true;
    }
    // Older snapshots were page-ordered. Normalizing once at load preserves
    // the index's O(n) newest/oldest inspector paths from then on.
    if (preserveLegacyOrder) {
      snapshot.sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    for (let item = 0; item < snapshot.length; item++) {
      index.put(snapshot[item]);
      if (item > 0 && item % 1_000 === 0) await yieldToHost();
    }
    if (await this.vault.adapter.exists(this.journalPath)) {
      const lines = (await this.vault.adapter.read(this.journalPath)).split("\n");
      for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const line = lines[lineNumber];
        if (!line.trim()) continue;
        try {
          const mutation = normalizeMutation(JSON.parse(line));
          if (!mutation) continue;
          index.apply(mutation);
          this.dirty = true;
        } catch { /* retain recoverable lines */ }
        if (lineNumber > 0 && lineNumber % 1_000 === 0) await yieldToHost();
      }
    }
    return index;
  }

  queue(mutation: AnnotationMutation): void {
    const key = mutation.op === "put" ? mutation.annotation.id : mutation.id;
    this.queued.set(key, mutation);
    this.dirty = true;
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => {
      void this.flushJournal().catch(error => console.error("Lumen could not flush its annotation journal", error));
    }, 220);
  }

  async flushJournal(): Promise<void> {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.flushing) {
      await this.flushing;
      if (this.queued.size) await this.flushJournal();
      return;
    }
    if (!this.queued.size) return;
    const operation = this.writeQueuedBatches();
    this.flushing = operation;
    try {
      await operation;
    } finally {
      if (this.flushing === operation) this.flushing = null;
    }
  }

  private async writeQueuedBatches(): Promise<void> {
    const batch = Array.from(this.queued.entries());
    let exists = await this.vault.adapter.exists(this.journalPath);
    for (let offset = 0; offset < batch.length; offset += 1_000) {
      const portion = batch.slice(offset, offset + 1_000);
      const payload = portion.map(([, value]) => JSON.stringify(value)).join("\n") + "\n";
      if (exists) await this.vault.adapter.append(this.journalPath, payload);
      else {
        await this.vault.adapter.write(this.journalPath, payload);
        exists = true;
      }
      for (const [key, mutation] of portion) {
        if (this.queued.get(key) === mutation) this.queued.delete(key);
      }
      if (offset + portion.length < batch.length) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
  }

  async checkpoint(index: AnnotationIndex): Promise<void> {
    await this.flushJournal();
    if (!this.dirty) return;
    const checkpointRevision = index.version;
    const annotations = index.all();
    if (await this.vault.adapter.exists(this.compactSnapshotPath)) {
      await this.vault.adapter.write(this.compactPreviousPath, await this.vault.adapter.read(this.compactSnapshotPath));
    }
    await this.vault.adapter.write(this.compactSnapshotPath, await compactSnapshot(annotations));
    if (index.version === checkpointRevision && this.queued.size === 0 && !this.flushing) {
      await this.vault.adapter.write(this.journalPath, "");
      this.dirty = false;
    } else {
      this.dirty = true;
    }
  }

  async exportTo(path: string, index: AnnotationIndex): Promise<void> {
    await this.checkpoint(index);
    const parent = normalizePath(path).split("/").slice(0, -1).join("/");
    if (parent) await ensureFolder(this.vault, parent);
    await this.vault.adapter.write(path, await snapshotMarkdown(index.all(), this.pdfPath, this.hash));
  }
}

export async function openBundle(
  vault: Vault,
  file: TFile,
  bytes: ArrayBuffer,
  automaticPdfBackup = false,
): Promise<DocumentBundle> {
  const hash = await documentHash(vault, file, bytes);
  const folder = normalizePath(`${ROOT}/${hash}`);
  await ensureFolder(vault, folder);
  const backupPath = `${folder}/document.pdf`;
  if (automaticPdfBackup && !(await vault.adapter.exists(backupPath))) schedulePdfBackup(vault, file.path, backupPath);
  const manifestPath = `${folder}/manifest.json`;
  const manifest: BundleManifest = {
    version: 1,
    sha256: hash,
    workingPath: file.path,
    originalName: file.name,
    updatedAt: new Date().toISOString(),
  };
  let shouldWriteManifest = true;
  if (await vault.adapter.exists(manifestPath)) {
    try {
      const previous = coerceManifest(JSON.parse(await vault.adapter.read(manifestPath)), hash);
      if (previous?.sha256 === hash && previous.workingPath === file.path && previous.originalName === file.name) {
        shouldWriteManifest = false;
      }
    } catch { /* replace malformed manifests */ }
  }
  if (shouldWriteManifest) await vault.adapter.write(manifestPath, JSON.stringify(manifest, null, 2));
  const repository = new AnnotationRepository(vault, folder, hash, file.path);
  return { hash, folder, repository };
}

function coerceManifest(value: unknown, hash: string): BundleManifest | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<BundleManifest>;
  if (typeof item.originalName !== "string") return null;
  return {
    version: typeof item.version === "number" ? item.version : 1,
    sha256: typeof item.sha256 === "string" ? item.sha256 : hash,
    workingPath: typeof item.workingPath === "string" ? item.workingPath : item.originalName,
    originalName: item.originalName,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date(0).toISOString(),
  };
}

export async function listBundles(vault: Vault): Promise<BundleInfo[]> {
  if (!(await vault.adapter.exists(ROOT))) return [];
  const listing = await vault.adapter.list(ROOT);
  const bundles: BundleInfo[] = [];
  for (const folder of listing.folders) {
    const hash = folder.split("/").pop() ?? "";
    const manifestPath = `${folder}/manifest.json`;
    const backupPath = `${folder}/document.pdf`;
    if (!hash || !(await vault.adapter.exists(manifestPath)) || !(await vault.adapter.exists(backupPath))) continue;
    try {
      const manifest = coerceManifest(JSON.parse(await vault.adapter.read(manifestPath)), hash);
      if (manifest) bundles.push({ hash, folder, backupPath, manifest });
    } catch { /* a malformed bundle is reported by verification only when discoverable */ }
  }
  return bundles.sort((a, b) => b.manifest.updatedAt.localeCompare(a.manifest.updatedAt));
}

export async function verifyBundle(vault: Vault, bundle: BundleInfo): Promise<BackupVerification> {
  try {
    const bytes = await vault.adapter.readBinary(bundle.backupPath);
    const actual = await sha256(bytes);
    if (actual !== bundle.hash || actual !== bundle.manifest.sha256) {
      return { bundle, ok: false, reason: `checksum mismatch (${actual})` };
    }
    return { bundle, ok: true };
  } catch (error) {
    return { bundle, ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "Recovered PDF.pdf";
}

async function availablePath(vault: Vault, preferred: string): Promise<string> {
  const normalized = normalizePath(preferred);
  if (!(await vault.adapter.exists(normalized))) return normalized;
  const dot = normalized.toLowerCase().endsWith(".pdf") ? normalized.length - 4 : normalized.length;
  const stem = normalized.slice(0, dot);
  const extension = normalized.slice(dot);
  for (let index = 2; ; index++) {
    const candidate = `${stem} ${index}${extension}`;
    if (!(await vault.adapter.exists(candidate))) return candidate;
  }
}

export async function restoreBundle(vault: Vault, bundle: BundleInfo): Promise<TFile> {
  const verification = await verifyBundle(vault, bundle);
  if (!verification.ok) throw new Error(verification.reason ?? "backup verification failed");
  const folder = ".lumen-pdf/recovered";
  await ensureFolder(vault, folder);
  const path = await availablePath(vault, `${folder}/${safeFileName(bundle.manifest.originalName)}`);
  return vault.createBinary(path, await vault.adapter.readBinary(bundle.backupPath));
}

function lastJsonFence(markdown: string): unknown {
  const expression = /```json(?:\s+[^\n]*)?\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  let value: unknown = null;
  while ((match = expression.exec(markdown)) !== null) {
    try { value = JSON.parse(match[1]); } catch { /* keep the last valid fenced value */ }
  }
  return value;
}

export async function loadLegacyAnnotations(vault: Vault, hash: string, pdfPath: string): Promise<LegacyAnnotationRecord[]> {
  const stem = normalizePath(pdfPath).replace(/\.pdf$/i, "");
  const candidates = [
    `${LEGACY_ROOT}/${hash}/annotations.md`,
    `PDF annotations/${stem}.annotations.md`,
    `${stem}.annotations.md`,
  ];
  const result: LegacyAnnotationRecord[] = [];
  const seen = new Set<string>();
  for (const path of candidates) {
    if (!(await vault.adapter.exists(path))) continue;
    try {
      const parsed = lastJsonFence(await vault.adapter.read(path));
      const records = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { highlights?: unknown[] }).highlights)
          ? (parsed as { highlights: unknown[] }).highlights
          : [];
      for (const value of records) {
        if (!value || typeof value !== "object") continue;
        const record = value as LegacyAnnotationRecord;
        const key = record.id ?? JSON.stringify([record.page, record.text, record.tagX, record.tagY]);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(record);
      }
    } catch { /* an invalid legacy source must not prevent the PDF from opening */ }
  }
  return result;
}
