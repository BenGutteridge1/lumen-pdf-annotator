import type { Vault } from "obsidian";
import { annotationUri } from "./links";
import type { AnnotationIndex, PdfAnnotation } from "./model";

interface ExportEntry {
  anchor: PdfAnnotation;
  members: PdfAnnotation[];
  pages: number[];
}

function escapeInline(value: string): string {
  return value.replace(/[\\`*_{}<>|]/g, "\\$&").replaceAll("[", "\\[").replaceAll("]", "\\]").replace(/[\r\n]+/g, " ");
}

function quoteLines(value: string): string[] {
  return value.trim().split(/\r?\n/).map(line => `> ${line}`);
}

function pageLabel(pages: number[]): string {
  return pages.length === 1 ? `Page ${pages[0]}` : `Pages ${pages.join(", ")}`;
}

function styleLabel(annotation: PdfAnnotation): string {
  if (annotation.kind === "page-note") return "Page note";
  return annotation.style === "comment" ? "Comment" : annotation.style.charAt(0).toUpperCase() + annotation.style.slice(1);
}

async function exportEntries(index: AnnotationIndex): Promise<ExportEntry[]> {
  const entries: ExportEntry[] = [];
  const logical = index.logicalAll();
  for (let position = 0; position < logical.length; position++) {
    const anchor = logical[position];
    const members = index.inGroup(anchor.id).sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0) || a.createdAt - b.createdAt);
    const pages = Array.from(new Set(members.map(item => item.page))).sort((a, b) => a - b);
    entries.push({ anchor, members, pages });
    if (position > 0 && position % 1_000 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  }
  entries.sort((a, b) => a.pages[0] - b.pages[0] || a.anchor.createdAt - b.anchor.createdAt || a.anchor.id.localeCompare(b.anchor.id));
  return entries;
}

/** A human-readable export. Recovery snapshots remain a separate, lossless format. */
export async function writeAnnotationExport(vault: Vault, path: string, index: AnnotationIndex, pdfPath: string): Promise<number> {
  const entries = await exportEntries(index);
  const partialPath = `${path}.partial`;
  const header = [
    `# Annotations — ${escapeInline(pdfPath.split("/").at(-1) ?? pdfPath)}`,
    "",
    `**PDF:** ${escapeInline(pdfPath)}  `,
    `**Exported:** ${new Date().toISOString()}  `,
    `**Annotations:** ${entries.length}`,
    "",
  ];
  await vault.adapter.write(partialPath, header.join("\n"));
  try {
    let batch: string[] = [];
    let currentPage = -1;
    for (let entryNumber = 0; entryNumber < entries.length; entryNumber++) {
      const { anchor, members, pages } = entries[entryNumber];
      if (pages[0] !== currentPage) {
        currentPage = pages[0];
        batch.push(`## Page ${currentPage}`, "");
      }
      batch.push(`### ${entryNumber + 1}. ${styleLabel(anchor)} · ${pageLabel(pages)}`, "");
      const quoted = members.filter(item => item.kind !== "page-note" && item.quote.trim());
      for (const member of quoted) {
        if (pages.length > 1) batch.push(`*Page ${member.page}*`, "");
        batch.push(...quoteLines(member.quote), "");
      }
      const note = members.find(item => item.id === (anchor.groupId || anchor.id) && item.note.trim())?.note
        ?? members.find(item => item.note.trim())?.note;
      if (note) batch.push("**Note**", "", note.trim(), "");
      const tags = members.find(item => item.tags.length)?.tags ?? [];
      if (tags.length) batch.push(`**Tags:** ${tags.map(escapeInline).join(", ")}`, "");
      const target = anchor.groupId || anchor.id;
      batch.push(`[Open in PDF](${annotationUri(vault.getName(), pdfPath, target)})`, "");
      if (entryNumber === entries.length - 1 || batch.length >= 500) {
        await vault.adapter.append(partialPath, batch.join("\n") + "\n");
        batch = [];
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
    }
    await vault.adapter.rename(partialPath, path);
    return entries.length;
  } catch (error) {
    if (await vault.adapter.exists(partialPath)) await vault.adapter.remove(partialPath);
    throw error;
  }
}
