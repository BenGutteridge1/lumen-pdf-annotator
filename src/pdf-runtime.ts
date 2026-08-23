import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import workerSource from "lumen-pdf-worker";

let workerUrl: string | null = null;
let sequence = 0;

export { pdfjs };

export function createPdfWorker(): { apiWorker: any; port: Worker } {
  if (!workerUrl) {
    workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  }
  const port = new Worker(workerUrl, { type: "module" });
  const apiWorker = new (pdfjs as any).PDFWorker({ name: `lumen-${++sequence}`, port });
  return { apiWorker, port };
}

export async function loadPdf(bytes: ArrayBuffer): Promise<{ document: any; worker: any; port: Worker }> {
  const { apiWorker, port } = createPdfWorker();
  try {
    const task = (pdfjs as any).getDocument({
      // openBundle() has already finished hashing/backing up these bytes. Let
      // PDF.js transfer this buffer to its worker instead of doubling a large
      // document in renderer memory first.
      data: new Uint8Array(bytes),
      worker: apiWorker,
      isEvalSupported: false,
      disableAutoFetch: true,
      useWorkerFetch: false,
    });
    return { document: await task.promise, worker: apiWorker, port };
  } catch (error) {
    try { await apiWorker.destroy(); } catch { /* worker setup may have failed before initialization */ }
    port.terminate();
    throw error;
  }
}

export function disposePdfRuntime(): void {
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = null;
}
