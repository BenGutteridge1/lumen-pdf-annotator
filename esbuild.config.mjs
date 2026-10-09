import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { builtinModules, createRequire } from "node:module";
import { buildPdfWorker, portablePromises, PDFJS_VERSION } from "./build/pdfjs-worker.mjs";

const require = createRequire(import.meta.url);
const production = process.argv[2] === "production";
const outputDirectory = process.env.LUMEN_PDF_ANNOTATOR_PLUGIN_DIR ?? path.resolve("dist");
const workerPath = require.resolve("pdfjs-dist/build/pdf.worker.mjs");
const pdfjsVersion = JSON.parse(fs.readFileSync(require.resolve("pdfjs-dist/package.json"), "utf8")).version;
if (pdfjsVersion !== PDFJS_VERSION) throw new Error(`Expected PDF.js ${PDFJS_VERSION}, found ${pdfjsVersion}`);
fs.mkdirSync(outputDirectory, { recursive: true });

function sanitizeApi(source, filename) {
  const before = `function isEvalSupported() {\n  try {\n    new Function(\"\");\n    return true;\n  } catch {\n    return false;\n  }\n}`;
  const after = `function isEvalSupported() {\n  return false;\n}`;
  if (!source.includes(before)) throw new Error(`Unable to disable PDF.js eval probe in ${filename}`);
  const result = portablePromises(source.replace(before, after), filename);
  if (result.includes("new Function") || result.includes("eval(")) throw new Error(`Runtime code generation remains in ${filename}`);
  return result;
}

const pdfPlugin = {
  name: "lumen-pdf-runtime",
  setup(build) {
    build.onResolve({ filter: /^lumen-pdf-worker$/ }, () => ({ path: workerPath, namespace: "lumen-worker" }));
    build.onLoad({ filter: /.*/, namespace: "lumen-worker" }, args => ({
      contents: buildPdfWorker(fs.readFileSync(args.path, "utf8"), pdfjsVersion),
      loader: "text",
    }));
    build.onLoad({ filter: /pdfjs-dist[/\\]build[/\\]pdf\.mjs$/ }, args => ({
      contents: sanitizeApi(fs.readFileSync(args.path, "utf8"), args.path),
      loader: "js",
    }));
  },
};

const copyReleaseFiles = {
  name: "copy-release-files",
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length) return;
      for (const name of ["manifest.json", "styles.css"]) {
        fs.copyFileSync(path.resolve(name), path.join(outputDirectory, name));
      }
    });
  },
};

const options = {
  entryPoints: ["src/main.ts"],
  outfile: path.join(outputDirectory, "main.js"),
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info",
  banner: {
    js: "/*! Lumen PDF Annotator © 2026 Ben Gutteridge, MIT. Includes Mozilla PDF.js 4.10.38, Apache-2.0. See THIRD_PARTY_NOTICES.md. */",
  },
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", ...builtinModules],
  plugins: [pdfPlugin, copyReleaseFiles],
};

if (production) await esbuild.build(options);
else {
  const context = await esbuild.context(options);
  await context.watch();
}
