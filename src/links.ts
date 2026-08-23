import type { PdfAnnotation } from "./model";

const ACTION = "lumen-pdf";

export function annotationUri(vault: string, file: string, annotationId: string): string {
  const params = { vault, file, annotation: annotationId };
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `obsidian://${ACTION}?${query}`;
}

export function annotationMarkdownLink(vault: string, file: string, annotation: PdfAnnotation): string {
  const target = annotation.groupId || annotation.id;
  const fallback = `${file.split("/").at(-1) ?? "PDF"} p.${annotation.page}`;
  const rawLabel = annotation.quote.trim() && annotation.quote !== "Page note" ? annotation.quote.trim() : fallback;
  const label = rawLabel.replace(/\s+/g, " ").slice(0, 80).replace(/[\\[\]]/g, "\\$&");
  return `[${label}](${annotationUri(vault, file, target)})`;
}

export const LUMEN_PROTOCOL_ACTION = ACTION;
