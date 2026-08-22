/**
 * pdf.js transfers the buffer supplied in `getDocument({ data })` to its
 * worker. Give it a dedicated copy so callers can safely retain the original
 * bytes for hashing, backup creation, or other work after the document opens.
 */
export function copyPdfDataForWorker(data: ArrayBuffer): Uint8Array {
  return new Uint8Array(data.slice(0));
}
