import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import type { PDFDocumentProxy, PDFWorker } from "pdfjs-dist/types/src/display/api";
import workerSource from "lumen-pdf-worker";

let workerUrl: string | null = null;
let sequence = 0;

export { pdfjs };

export function createPdfWorker(): { apiWorker: PDFWorker; port: Worker } {
  if (!workerUrl) {
    workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  }
  const port = new Worker(workerUrl, { type: "module" });
  const apiWorker = new pdfjs.PDFWorker({ name: `lumen-${++sequence}`, port });
  return { apiWorker, port };
}

export async function loadPdf(bytes: ArrayBuffer): Promise<{ document: PDFDocumentProxy; worker: PDFWorker; port: Worker }> {
  const { apiWorker, port } = createPdfWorker();
  try {
    const task = pdfjs.getDocument({
      // Bundle discovery has finished reading these bytes. Let PDF.js transfer
      // the buffer to its worker instead of doubling a large document in the
      // renderer process first.
      data: new Uint8Array(bytes),
      worker: apiWorker,
      isEvalSupported: false,
      disableAutoFetch: true,
      useWorkerFetch: false,
    });
    return { document: await task.promise, worker: apiWorker, port };
  } catch (error) {
    try { await Promise.resolve(apiWorker.destroy()); } catch { /* worker setup may have failed before initialization */ }
    port.terminate();
    throw error;
  }
}

export function disposePdfRuntime(): void {
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = null;
}
