import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { buildPdfWorker, patchPdfWorker, lumenFontTextRecoveries, PDFJS_VERSION, MAX_FONT_RECOVERIES } from '../build/pdfjs-worker.mjs';

const require = createRequire(import.meta.url);
const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.mjs');
const source = fs.readFileSync(workerPath, 'utf8');
const names = ['.notdef', 'f_i', 'f_l', 'f_f_i', 'f_f', 'unknown', 'A'];
const unicodeNames = { f: 102, i: 105, l: 108, A: 65, control: 10, private: 0xe001, surrogate: 0xd800, invisible: 0x200b };
function recover(mapping, glyphNames = names, unicode = {}, hasGlyph = () => true) {
  return lumenFontTextRecoveries(mapping, glyphNames, { get: code => unicode[code] }, hasGlyph, () => unicodeNames);
}

test('font fallback resolves missing/NUL names by glyph id and preserves every valid mapping', () => {
  const result = recover({ 900: 1, 40: 2, 13: 3, 14: 4, 15: 5, 16: 6 }, names,
    { 900: '\u0000', 13: '\u0000', 14: 'valid text', 16: 'Z' });
  assert.deepEqual({ ...result }, { 900: 'fi', 40: 'fl', 13: 'ffi' });
  assert.equal(recover({ 1: 1 }, names, { 1: 'ﬁ' }), undefined);
  assert.equal(recover({ 1: 1 }, names, { 1: '�' }), undefined);
  assert.equal(recover({ 1: 1 }, names, { 1: 0 }), undefined);
});

test('fallback rejects absent, malformed, synthetic, control, private and unsupported glyph declarations', () => {
  for (const name of ['.notdef', '', 'f_i.alt', 'uni0066', 'u0066', 'f__i', 'unknown', 'control', 'private', 'surrogate', 'invisible', 'f_'.repeat(40)]) {
    assert.equal(recover({ 8: 1 }, ['.notdef', name]), undefined, name);
  }
  assert.equal(recover({ 0: 0, 1: -1, 2: 99, 3: 1.5 }), undefined);
  assert.equal(recover({ '-1': 1, '1.5': 1, '4294967296': 1 }), undefined);
  assert.equal(recover({ 8: 1 }, names, {}, () => false), undefined);
  assert.equal(recover({ 8: 1 }, null), undefined);
  const inherited = Object.create({ f: 102 });
  assert.equal(lumenFontTextRecoveries({ 1: 1 }, ['.notdef', 'f'], { get() {} }, () => true, () => inherited), undefined);
});

test('recovery cache is bounded and contains strings only, independent of font buffers/names', () => {
  const mapping = Object.fromEntries(Array.from({ length: MAX_FONT_RECOVERIES }, (_, index) => [index, 1]));
  const result = recover(mapping);
  assert.equal(Object.keys(result).length, MAX_FONT_RECOVERIES);
  names[1] = 'A';
  assert.equal(result[0], 'fi');
  names[1] = 'f_i';
  mapping[MAX_FONT_RECOVERIES] = 1;
  assert.equal(recover(mapping), undefined);
});

test('worker build rejects dependency/source drift and removes runtime eval/new Function/new promises', () => {
  assert.throws(() => patchPdfWorker(source, '4.10.39'), /pinned PDF.js/);
  assert.throws(() => patchPdfWorker(source.replace('const pdfjsVersion = "4.10.38";', ''), PDFJS_VERSION), /pinned PDF.js/);
  for (const needle of ['      propertiesObj.glyphNames = glyphNames;', '        const glyphUnicode = glyph.unicode;', '      textContentItem.str.length = 0;']) {
    assert.throws(() => patchPdfWorker(source.replace(needle, ''), PDFJS_VERSION), /unexpected .* layout/);
    assert.throws(() => patchPdfWorker(source + needle + '\n', PDFJS_VERSION), /unexpected .* layout/);
  }
  const built = buildPdfWorker(source, PDFJS_VERSION);
  assert.equal(/\b(?:eval\s*\(|new\s+Function\b|Promise\.withResolvers\s*\()/.test(built), false);
  assert.ok(built.includes('Mozilla Foundation'));
});

// This tiny original test font was generated with FontBuilder, with rectangular
// glyph outlines and format-2 post names; it contains no third-party font data.
const syntheticFont = Buffer.from('AAEAAAAJAIAAAwAQT1MvMkTgQ5AAAAEYAAAAYGdseWZMw0y8AAABoAAAANBoZWFkYKZDOAAAAJwAAAA2aGhlYQSyAcQAAADUAAAAJGhtdHgCvADIAAABeAAAABJsb2NhAQQA0AAAAYwAAAASbWF4cAAKAAYAAAD4AAAAIG5hbWWjxczkAAACcAAAAOpwb3N0Btzv9QAAA1wAAABPAAEAAAABAAC+NdY2Xw889QADA+gAAAAAAAAAAAAAAAAAAAAAADIAAAFeAlgAAAADAAIAAAAAAAAAAQAAAyD/OAAAAfQAMgCWAV4AAQAAAAAAAAAAAAAAAAAAAAEAAQAAAAgABAABAAAAAAACAAAAAAAAAAAAAAAAAAAAAAADAfQBkAAFAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAA/Pz8/AAAAAAAAAyD/OAAAAyAAyAAAAAAAAAAAAAAAAAAAACAAAAH0ADIAMgAyADIAMgAyADIAMgAAAAAADQAaACcANABBAE4AWwBoAAAAAQAyAAABXgJYAAMAADMhESEyASz+1AJYAAABADIAAAFeAlgAAwAAMyERITIBLP7UAlgAAAEAMgAAAV4CWAADAAAzIREhMgEs/tQCWAAAAQAyAAABXgJYAAMAADMhESEyASz+1AJYAAABADIAAAFeAlgAAwAAMyERITIBLP7UAlgAAAEAMgAAAV4CWAADAAAzIREhMgEs/tQCWAAAAQAyAAABXgJYAAMAADMhESEyASz+1AJYAAABADIAAAFeAlgAAwAAMyERITIBLP7UAlgAAAAACgB+AAEAAAAAAAEADwAAAAEAAAAAAAIABwAPAAEAAAAAAAMADgAWAAEAAAAAAAQADwAAAAEAAAAAAAYADgAWAAMAAQQJAAEAHgAkAAMAAQQJAAIADgBCAAMAAQQJAAMAHABQAAMAAQQJAAQAHgAkAAMAAQQJAAYAHABQTHVtZW4gU3ludGhldGljUmVndWxhckx1bWVuU3ludGhldGljAEwAdQBtAGUAbgAgAFMAeQBuAHQAaABlAHQAaQBjAFIAZQBnAHUAbABhAHIATAB1AG0AZQBuAFMAeQBuAHQAaABlAHQAaQBjAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAJAECAQMBBAEFAQYAwANmX2kDZl9sBWZfZl9pA2ZfZgpnbHlwaEJvZ3VzAA==', 'base64');
function makePdf(font = syntheticFont) {
  const objects = [];
  const add = value => objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  const stream = (data, extra = '') => Buffer.concat([Buffer.from(`<< /Length ${data.length} ${extra} >>\nstream\n`), data, Buffer.from('\nendstream')]);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R >>');
  add('<< /Type /Font /Subtype /Type0 /BaseFont /LumenSynthetic /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 9 0 R >>');
  add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LumenSynthetic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /CIDToGIDMap /Identity /DW 500 >>');
  add('<< /Type /FontDescriptor /FontName /LumenSynthetic /Flags 4 /FontBBox [0 0 500 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 600 /StemV 80 /FontFile2 7 0 R >>');
  add(stream(font, `/Length1 ${font.length}`));
  add(stream(Buffer.from('BT /F1 16 Tf 20 40 Td <0001000200030004000500060007> Tj ET')));
  add(stream(Buffer.from('/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 6 beginbfchar <0001> <0041> <0002> <0000> <0004> <0000> <0005> <0000> <0006> <0000> <0007> <005A> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end')));
  const parts = [Buffer.from('%PDF-1.7\n')];
  const offsets = [0];
  let length = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    parts.push(chunk); length += chunk.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
  return Buffer.concat(parts);
}

function extract(pdfPath, patched, pages = [1]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-font-test-'));
  const patchedWorker = path.join(directory, 'pdf.worker.mjs');
  fs.writeFileSync(patchedWorker, buildPdfWorker(source, PDFJS_VERSION));
  const script = `
    import fs from 'node:fs'; import { createHash } from 'node:crypto'; import { pathToFileURL } from 'node:url';
    const pdfjs = await import(pathToFileURL(${JSON.stringify(require.resolve('pdfjs-dist/build/pdf.mjs'))}));
    pdfjs.GlobalWorkerOptions.workerSrc = ${JSON.stringify(patched ? patchedWorker : workerPath)};
    const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(${JSON.stringify(pdfPath)})), isEvalSupported: false, useSystemFonts: false, fontExtraProperties: true });
    const document = await task.promise;
    const output = [];
    for (const pageNumber of ${JSON.stringify(pages)}) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent(); const operators = await page.getOperatorList();
      const clean = JSON.stringify(operators, (key, value) => key === 'lumenUnicode' ? undefined : value);
      const fonts = {};
      for (const name of Object.keys(text.styles)) {
        const font = page.commonObjs.get(name);
        if (!font.data?.byteLength) throw new Error('Expected retained embedded font bytes for diagnostic comparison');
        fonts[name] = createHash('sha256').update(font.data).digest('hex');
      }
      output.push({ page: pageNumber, text: text.items.map(item => item.str ?? '').join(''), items: text.items,
        operators: createHash('sha256').update(clean).digest('hex'), fonts });
    }
    await document.destroy(); console.log('LUMEN_RESULT:' + JSON.stringify(output));
  `;
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    return JSON.parse(output.split('LUMEN_RESULT:')[1]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('real worker extracts a synthetic embedded font without changing rendering operators or font data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-synthetic-pdf-'));
  const filename = path.join(directory, 'synthetic.pdf');
  fs.writeFileSync(filename, makePdf());
  try {
    const [baseline] = extract(filename, false);
    const [candidate] = extract(filename, true);
    assert.ok(baseline.text.includes('\u0000'));
    assert.equal(candidate.text, 'Afiflffiff\u0000Z');
    assert.equal(candidate.items.some(item => item.lumenTextRepaired), true);
    assert.equal(candidate.operators, baseline.operators);
    assert.deepEqual(candidate.fonts, baseline.fonts);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('malformed original post table cannot supply semantic recoveries', () => {
  const font = Buffer.from(syntheticFont);
  const tableCount = font.readUInt16BE(4);
  let post;
  for (let index = 0; index < tableCount; index++) {
    const row = 12 + index * 16;
    if (font.toString('ascii', row, row + 4) === 'post') post = font.readUInt32BE(row + 8);
  }
  assert.ok(post);
  font.writeUInt16BE(99, post + 32); // Contradicts maxp glyph count.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-malformed-pdf-'));
  const filename = path.join(directory, 'malformed.pdf');
  fs.writeFileSync(filename, makePdf(font));
  try {
    const [result] = extract(filename, true);
    assert.equal(result.items.some(item => item.lumenTextRepaired), false);
    assert.ok(result.text.includes('\u0000'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('truncated post header/indexes and Pascal name overrun reject recovery without changing rendering', () => {
  const tableCount = syntheticFont.readUInt16BE(4);
  let row;
  for (let index = 0; index < tableCount; index++) {
    const offset = 12 + index * 16;
    if (syntheticFont.toString('ascii', offset, offset + 4) === 'post') row = offset;
  }
  assert.ok(row);
  const post = syntheticFont.readUInt32BE(row + 8);
  const namesStart = post + 34 + 2 * syntheticFont.readUInt16BE(post + 32);
  for (const length of [30, 40, namesStart - post + 2]) {
    const font = Buffer.from(syntheticFont);
    // Leave following bytes in the font: the upstream parser can read them,
    // but they are outside the declared post table and cannot support repair.
    font.writeUInt32BE(length, row + 12);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-post-bounds-pdf-'));
    const filename = path.join(directory, 'bounds.pdf');
    fs.writeFileSync(filename, makePdf(font));
    try {
      const [baseline] = extract(filename, false);
      const [candidate] = extract(filename, true);
      assert.equal(candidate.items.some(item => item.lumenTextRepaired), false);
      assert.equal(candidate.text, baseline.text);
      assert.equal(candidate.operators, baseline.operators);
      assert.deepEqual(candidate.fonts, baseline.fonts);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test('optional private PDF diagnostic checks representative pages without retaining the fixture', { skip: !process.env.LUMEN_TEST_PDF }, () => {
  const filename = process.env.LUMEN_TEST_PDF;
  const baseline = extract(filename, false, [287, 288]);
  const candidate = extract(filename, true, [287, 288]);
  assert.deepEqual(baseline.map(page => [...page.text].filter(character => character === '\u0000').length), [18, 12]);
  assert.deepEqual(candidate.map(page => [...page.text].filter(character => character === '\u0000').length), [0, 0]);
  for (let index = 0; index < baseline.length; index++) {
    assert.equal(candidate[index].operators, baseline[index].operators);
    assert.deepEqual(candidate[index].fonts, baseline[index].fonts);
    assert.equal(candidate[index].items.some(item => item.lumenTextRepaired), true);
  }
});
