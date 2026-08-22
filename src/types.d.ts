// The bundled pdf.js worker source, inlined as a string by esbuild's text loader
// (see the inline-pdf-worker plugin in esbuild.config.mjs). At runtime we turn
// this into a Blob URL module worker — never a path on disk.
declare module "pdfjs-worker-inline" {
  const workerSource: string;
  export default workerSource;
}

// pdfjs-dist 4 publishes declarations as .d.mts, which TypeScript's current
// CommonJS resolution mode does not associate with this explicit .mjs import.
declare module "pdfjs-dist/build/pdf.mjs";

// Injected by esbuild `define` at build time: the exact installed pdfjs-dist
// package version. Used by the runtime self-check in pdf-engine.ts.
declare const __PDFJS_BUILD_VERSION__: string;
