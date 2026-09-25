import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/outline.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
});
const { cacheOutlineHeadingLocation, exactOutlineHeadingGeometry, findExactOutlineHeading, resolvePdfOutline } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

function page(...parts) {
  let text = '';
  const spans = [];
  for (const part of parts) {
    if (text) text += ' ';
    const start = text.length;
    text += part.text;
    if (part.span !== false) spans.push({
      start,
      end: text.length,
      rect: { x: part.x ?? .1, y: part.y ?? .2, width: part.width ?? .3, height: part.height ?? .025 },
    });
  }
  return { text, spans };
}

test('inline mentions do not stop a nearby heading search', async () => {
  const pages = new Map([
    [1, page({ text: 'See Introduction for background', y: .4 })],
    [2, page({ text: 'Introduction', y: .2 })],
  ]);
  const reads = [];
  const found = await findExactOutlineHeading('Introduction', 1, 4, async number => {
    reads.push(number);
    return pages.get(number) ?? page();
  });
  assert.equal(found?.pageNumber, 2);
  assert.deepEqual(reads, [1, 2]);
});

test('printed contents rows with distant folios do not hide actual headings', async () => {
  const pages = new Map([
    [7, page({ text: 'Abstract', x: .12, y: .28, width: .09 }, { text: 'i', x: .87, y: .28, width: .01 })],
    [3, page({ text: 'Abstract', x: .45, y: .06, width: .1 })],
  ]);
  const found = await findExactOutlineHeading('Abstract', 7, 10, async number => pages.get(number) ?? page());
  assert.equal(found?.pageNumber, 3);
  assert.equal(exactOutlineHeadingGeometry(page({ text: 'Results .......... 42' }), 'Results'), null);
  assert.equal(exactOutlineHeadingGeometry(page(
    { text: 'Results', x: .12, y: .28, width: .1 },
    { text: '42', x: .87, y: .28, width: .02 },
  ), 'Results'), null);
});

test('running headers with a distant folio do not hide a heading', async () => {
  const pages = new Map([
    [16, page(
      { text: '2', x: .12, y: .02, width: .01 },
      { text: 'Chapter 1.', x: .66, y: .02, width: .1 },
      { text: 'Introduction', x: .77, y: .02, width: .11 },
    )],
    [15, page({ text: 'Introduction', x: .12, y: .25 })],
  ]);
  const found = await findExactOutlineHeading('Introduction', 16, 20, async number => pages.get(number) ?? page());
  assert.equal(found?.pageNumber, 15);
  assert.ok(exactOutlineHeadingGeometry(page(
    { text: 'Chapter 1.', x: .12, y: .2, width: .1 },
    { text: 'Introduction', x: .23, y: .2, width: .2 },
  ), 'Introduction'));
  assert.equal(exactOutlineHeadingGeometry(page(
    { text: '2.3.', x: .12, y: .02, width: .04 },
    { text: 'Machine Unlearning', x: .17, y: .02, width: .17 },
    { text: '17', x: .86, y: .02, width: .02 },
  ), 'Machine Unlearning'), null);
});

test('rejects incomplete, disconnected and partial-title geometry', () => {
  assert.equal(exactOutlineHeadingGeometry(page(
    { text: 'Experimental', y: .1 },
    { text: 'Results', y: .8 },
  ), 'Experimental Results'), null);
  assert.equal(exactOutlineHeadingGeometry(page(
    { text: 'Experimental', x: .8, y: .2, width: .15 },
    { text: 'Results', x: .1, y: .2, width: .15 },
  ), 'Experimental Results'), null);
  assert.equal(exactOutlineHeadingGeometry(page(
    { text: 'Experimental', x: .1, y: .2, width: .15 },
    { text: 'Results', x: .8, y: .235, width: .15 },
  ), 'Experimental Results'), null);
  assert.equal(exactOutlineHeadingGeometry(page(
    { text: 'Full', y: .2 },
    { text: 'Title', y: .2, span: false },
  ), 'Full Title'), null);
  assert.equal(exactOutlineHeadingGeometry(page(
    { text: 'Introduction to Machine Learning', y: .2 },
  ), 'Introduction'), null);
  assert.equal(exactOutlineHeadingGeometry(page({ text: 'Redesign' }), 'Design'), null);
});

test('keeps split full titles on one line and sensible wrapped lines', () => {
  const sameLine = exactOutlineHeadingGeometry(page(
    { text: 'Technical', x: .1, y: .2, width: .17 },
    { text: 'Foundations', x: .28, y: .2, width: .19 },
  ), 'Technical Foundations');
  assert.equal(sameLine?.topRatio, .2);
  assert.ok(exactOutlineHeadingGeometry(page(
    { text: 'Technical', x: .5, y: .2, width: .2 },
    { text: 'Foundations', x: .28, y: .2, width: .21 },
  ), 'Technical Foundations'));
  const wrapped = exactOutlineHeadingGeometry(page(
    { text: 'Technical Foundations', x: .1, y: .2, width: .55 },
    { text: 'and Challenges', x: .1, y: .235, width: .4 },
  ), 'Technical Foundations and Challenges');
  assert.equal(wrapped?.topRatio, .2);
  assert.ok(wrapped && wrapped.heightRatio > .05 && wrapped.heightRatio < .07);
});

test('matches canonical accents and typographic ligatures using original span offsets', () => {
  assert.ok(exactOutlineHeadingGeometry(page({ text: 'Re\u0301sume\u0301' }), 'Résumé'));
  assert.ok(exactOutlineHeadingGeometry(page({ text: 'Oﬃce' }), 'Office'));
  const shifted = exactOutlineHeadingGeometry(page(
    { text: 'İ'.repeat(20), y: .1 },
    { text: 'Introduction', y: .3 },
  ), 'Introduction');
  assert.equal(shifted?.topRatio, .3);
  assert.equal(exactOutlineHeadingGeometry(page({ text: 'ﬃ' }), 'f'), null);
});

test('keeps complete source titles, hierarchy and bounded validation reads', async () => {
  const document = {
    numPages: 10,
    async getDestination() { return null; },
    async getPageIndex() { return 0; },
    cachedPageNumber() { return null; },
  };
  const entries = await resolvePdfOutline(document, [
    { title: '  Chapter   One ', dest: [0, { name: 'Fit' }], items: [
      { title: 'Complete Subchapter Name', dest: [1, { name: 'Fit' }], items: [] },
    ] },
  ]);
  assert.deepEqual(entries.map(entry => [entry.title, entry.depth]), [
    ['Chapter One', 0], ['Complete Subchapter Name', 1],
  ]);
  assert.equal(cacheOutlineHeadingLocation(entries[0], null), false);
  assert.equal(entries[0].pageNumber, entries[0].declaredPageNumber);
  assert.equal(entries[0].validation, 'unmatched');
  let reads = 0;
  await findExactOutlineHeading('Absent', 5, 10, async () => {
    reads++;
    return page();
  });
  assert.equal(reads, 9);
});

test('absent or non-navigable PDF outlines stay empty', async () => {
  const document = {
    numPages: 4,
    async getDestination() { return null; },
    async getPageIndex() { return 0; },
    cachedPageNumber() { return null; },
  };
  for (const source of [null, undefined, {}, [], [
    { title: 'Printed contents only', dest: null, items: [] },
    { title: 'Invalid destination', dest: [99, { name: 'Fit' }], items: [] },
  ]]) {
    assert.deepEqual(await resolvePdfOutline(document, source), []);
  }
});
