import { transformSync } from "esbuild";

export const PDFJS_VERSION = "4.10.38";
export const MAX_FONT_RECOVERIES = 4096;

/** Retain only otherwise missing mappings, using the already validated render map. */
export function lumenFontTextRecoveries(mapping, names, toUnicode, hasGlyph, getUnicodeNames) {
  if (!Array.isArray(names)) return undefined;
  let recovered;
  let count = 0;
  let unicodeNames;
  for (const code in mapping) {
    const charCode = Number(code);
    const gid = mapping[code];
    const existing = toUnicode.get(charCode);
    if (existing !== undefined && existing !== "" && existing !== "\u0000") continue;
    if (!Number.isInteger(charCode) || charCode < 0 || charCode > 0xffffffff
      || !Number.isInteger(gid) || gid <= 0 || gid >= names.length || !hasGlyph(gid)) continue;
    const name = names[gid];
    // No font-family assumptions, suffix guesses, synthetic uni names, or .notdef.
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) continue;
    const components = name.split("_");
    if (components.length > 8) continue;
    unicodeNames ||= getUnicodeNames();
    let text = "";
    for (const component of components) {
      const point = Object.prototype.hasOwnProperty.call(unicodeNames, component) ? unicodeNames[component] : undefined;
      // Reject controls, separators, private-use, surrogates and replacement chars.
      if (!Number.isInteger(point) || point < 0x21 || point > 0x10ffff
        || (point >= 0x7f && point <= 0x9f) || (point >= 0xd800 && point <= 0xf8ff)
        || point === 0xfffd || (point >= 0xf0000 && point <= 0xffffd)
        || (point >= 0x100000 && point <= 0x10fffd)) { text = ""; break; }
      const character = String.fromCodePoint(point);
      if (/[\p{C}\p{Z}]/u.test(character)) { text = ""; break; }
      text += character;
    }
    if (!text) continue;
    // A hostile font cannot retain an unbounded additional cache.
    if (++count > 4096) return undefined;
    recovered ||= Object.create(null);
    recovered[charCode] = text;
  }
  return recovered;
}

function replaceExactlyOnce(source, before, after, label) {
  if (source.split(before).length !== 2) {
    throw new Error(`PDF.js ${PDFJS_VERSION}: unexpected ${label} layout; review the worker patch before updating PDF.js`);
  }
  return source.replace(before, after);
}

export function portablePromises(source, filename) {
  const helper = "function lumenPromiseWithResolvers(){let resolve,reject;const promise=new Promise((accept,decline)=>{resolve=accept;reject=decline});return{promise,resolve,reject}}\n";
  const result = source.replaceAll("Promise.withResolvers()", "lumenPromiseWithResolvers()");
  if (result.includes("Promise.withResolvers(")) throw new Error(`Unexpected promise capability call in ${filename}`);
  return helper + result;
}

export function patchPdfWorker(source, version) {
  if (version !== PDFJS_VERSION || !source.includes(`const pdfjsVersion = "${PDFJS_VERSION}";`)) {
    throw new Error(`Font text repair requires pinned PDF.js ${PDFJS_VERSION}; review the patch before upgrading`);
  }
  const license = source.match(/^\/\*\*[\s\S]*?@licend[\s\S]*?\*\//)?.[0];
  if (!license) throw new Error("Missing PDF.js worker license notice");
  source = source.replace(license, license.replace("/**", "/*!"));
  // Upstream tolerates malformed post names for rendering. Recovery has a
  // stricter, separate bounds check; do not change its parser or glyph array.
  source = replaceExactlyOnce(source,
    '      const length = post.length,\n        end = start + length;\n      const version = font.getInt32();',
    '      const length = post.length,\n        end = start + length;\n      let lumenPostBoundsValid = Number.isSafeInteger(length) && length >= 32 && start >= 0 && end <= font.end;\n      const version = font.getInt32();', 'post table bounds');
  source = replaceExactlyOnce(source,
    '        case 0x00020000:\n          const numGlyphs = font.getUint16();',
    '        case 0x00020000:\n          const numGlyphs = font.getUint16();\n          lumenPostBoundsValid &&= length >= 34 + 2 * numGlyphs;', 'post name indexes');
  source = replaceExactlyOnce(source,
    '          while (font.pos < end) {\n            const stringLength = font.getByte();',
    '          while (font.pos < end) {\n            const stringLength = font.getByte();\n            lumenPostBoundsValid &&= stringLength >= 0 && font.pos + stringLength <= end;', 'post Pascal names');
  source = replaceExactlyOnce(source,
    '      propertiesObj.glyphNames = glyphNames;',
    '      propertiesObj.lumenValidGlyphNames = valid && lumenPostBoundsValid && (version === 0x00010000 || version === 0x00020000) && Array.isArray(glyphNames) && glyphNames.length === maxpNumGlyphs;\n      propertiesObj.glyphNames = glyphNames;', 'original post table');
  // Insert after adjustMapping/cmap generation: the rendering mapping is never changed.
  source = replaceExactlyOnce(source, '    if (!isTrueType) {\n      try {\n        cffFile',
    '    if (isTrueType && properties.lumenValidGlyphNames && !properties.cssFontInfo) {\n      this.lumenTextRecoveries = lumenFontTextRecoveries(charCodeToGlyphId, properties.glyphNames, this.toUnicode, hasGlyph, getGlyphsUnicode);\n    }\n    if (!isTrueType) {\n      try {\n        cffFile', 'TrueType render mapping');
  source = replaceExactlyOnce(source,
    '    glyph = new fonts_Glyph(charcode, fontChar, unicode, accent, width, vmetric, operatorListId, isSpace, isInFont);',
    '    glyph = new fonts_Glyph(charcode, fontChar, unicode, accent, width, vmetric, operatorListId, isSpace, isInFont);\n    const recovered = this.lumenTextRecoveries?.[charcode];\n    if (recovered) glyph.lumenUnicode = recovered;', 'glyph cache');
  source = replaceExactlyOnce(source, '        const glyphUnicode = glyph.unicode;',
    '        const glyphUnicode = glyph.lumenUnicode || glyph.unicode;\n        if (glyph.lumenUnicode) textChunk.lumenTextRepaired = true;', 'text-only extraction');
  source = replaceExactlyOnce(source, '        hasEOL: textChunk.hasEOL\n',
    '        hasEOL: textChunk.hasEOL,\n        ...(textChunk.lumenTextRepaired ? { lumenTextRepaired: true } : {})\n', 'text item metadata');
  source = replaceExactlyOnce(source, '      textContentItem.str.length = 0;\n',
    '      textContentItem.str.length = 0;\n      textContentItem.lumenTextRepaired = false;\n', 'text item reset');
  source = replaceExactlyOnce(source,
    'function isEvalSupported() {\n  try {\n    new Function("");\n    return true;\n  } catch {\n    return false;\n  }\n}',
    'function isEvalSupported() {\n  return false;\n}', 'eval probe');
  source = replaceExactlyOnce(source,
    '    if (isEvalSupported && FeatureTest.isEvalSupported) {\n      const compiled = new PostScriptCompiler().compile(code, domain, range);\n      if (compiled) {\n        return new Function("src", "srcOffset", "dest", "destOffset", compiled);\n      }\n    }', '', 'PostScript compiler');
  source = portablePromises(`${lumenFontTextRecoveries.toString()}\n${source}`, 'PDF.js worker');
  if (source.includes("new Function") || /\beval\s*\(/.test(source)) throw new Error("Runtime code generation remains in PDF.js worker");
  return source;
}

export function buildPdfWorker(source, version) {
  return transformSync(patchPdfWorker(source, version), {
    loader: "js", minify: true, target: "es2022", legalComments: "inline",
  }).code;
}
