declare module "lumen-pdf-worker" {
  const source: string;
  export default source;
}

declare module "pdfjs-dist/build/pdf.mjs" {
  import { getDocument as getDocumentApi, PDFDocumentLoadingTask, PDFWorker as PDFWorkerClass } from "pdfjs-dist/types/src/display/api";
  import { TextLayer as TextLayerClass } from "pdfjs-dist/types/src/display/text_layer";
  import { GlobalWorkerOptions as GlobalWorkerOptionsClass } from "pdfjs-dist/types/src/display/worker_options";
  export const getDocument: typeof getDocumentApi;
  export const PDFWorker: {
    new (options?: { name?: string; port?: Worker }): PDFWorkerClass;
  };
  export const TextLayer: typeof TextLayerClass;
  export const GlobalWorkerOptions: typeof GlobalWorkerOptionsClass;
  export type { PDFDocumentLoadingTask };
}
